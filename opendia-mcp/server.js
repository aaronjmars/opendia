#!/usr/bin/env node

const WebSocket = require("ws");
const express = require("express");
const net = require('net');
const { exec } = require('child_process');

// SSE transport
const cors = require('cors');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Command line argument parsing
const args = process.argv.slice(2);
const enableTunnel = args.includes('--tunnel') || args.includes('--auto-tunnel');
const sseOnly = args.includes('--sse-only');

function usageError(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

// Returns the text after `=`, or null when the flag is absent. An empty value
// (`--token=`) is a usage error, not an empty string: treating it as falsy is
// what let `--token=` disable auth outright and `--http-host=` bind 0.0.0.0.
function argValue(name) {
  const flag = args.find(arg => arg.startsWith(`${name}=`));
  if (flag === undefined) return null;
  const value = flag.slice(name.length + 1);
  if (value === '') usageError(`${name}= requires a value`);
  return value;
}

// Digits only — Number() would accept '0x1f' and parseInt() would accept '80abc'.
function portValue(name) {
  const raw = argValue(name);
  if (raw === null) return null;
  if (!/^\d+$/.test(raw) || raw < 1 || raw > 65535) {
    usageError(`${name}=${raw} is not a valid port (expected an integer 1-65535)`);
  }
  return Number(raw);
}

// `POST /sse` hands whatever it receives to handleMCPRequest, which drives the
// browser through the extension. Keep that surface on loopback by default; the
// extension reaches it at localhost and `ngrok http` connects from this machine
// too, so neither needs an off-host bind. --http-host= widens it deliberately.
const HTTP_HOST = argValue('--http-host') ?? '127.0.0.1';

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// Once the MCP surface is reachable beyond this machine — widened bind or an
// ngrok tunnel — loopback stops being the boundary and callers must present a
// token. Locally it stays off so existing setups keep working untouched.
const explicitToken = argValue('--token');
const requiresToken = enableTunnel || !isLoopbackHost(HTTP_HOST);
const AUTH_TOKEN = requiresToken
  ? (explicitToken ?? crypto.randomBytes(24).toString('hex'))
  : null;

// Default ports
const wsPortArg = portValue('--ws-port');
const httpPortArg = portValue('--http-port');
const portArg = portValue('--port');
let WS_PORT = wsPortArg ?? portArg ?? 5555;
let HTTP_PORT = httpPortArg ?? (portArg !== null ? portArg + 1 : 5556);
if (HTTP_PORT > 65535) {
  usageError(`--port=${portArg} leaves no room for the HTTP port (${HTTP_PORT})`);
}

// Port conflict detection utilities
async function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.once('close', () => resolve(false));
      server.close();
    });
    server.on('error', () => resolve(true));
  });
}

async function checkIfOpenDiaProcess(port) {
  return new Promise((resolve) => {
    exec(`lsof -ti:${port}`, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(false);
        return;
      }
      
      const pid = stdout.trim().split('\n')[0];
      exec(`ps -p ${pid} -o command=`, (psError, psOutput) => {
        resolve(!psError && (
          psOutput.includes('opendia') || 
          psOutput.includes('server.js') ||
          psOutput.includes('node') && psOutput.includes('opendia')
        ));
      });
    });
  });
}

async function findAvailablePort(startPort) {
  let port = startPort;
  while (await checkPortInUse(port)) {
    port++;
    if (port > startPort + 100) { // Safety limit
      throw new Error(`Could not find available port after checking ${port - startPort} ports`);
    }
  }
  return port;
}

async function killExistingOpenDia(port) {
  return new Promise((resolve) => {
    exec(`lsof -ti:${port}`, async (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(false);
        return;
      }
      
      const pids = stdout.trim().split('\n');
      let killedAny = false;
      
      for (const pid of pids) {
        const isOpenDia = await checkIfOpenDiaProcess(port);
        if (isOpenDia) {
          exec(`kill ${pid}`, (killError) => {
            if (!killError) {
              console.error(`🔧 Killed existing OpenDia process (PID: ${pid})`);
              killedAny = true;
            }
          });
        }
      }
      
      // Wait a moment for processes to fully exit
      setTimeout(() => resolve(killedAny), 1000);
    });
  });
}

async function handlePortConflict(port, portName) {
  const isInUse = await checkPortInUse(port);
  
  if (!isInUse) {
    return port; // Port is free, use it
  }
  
  // Port is busy - give user options
  console.error(`⚠️  ${portName} port ${port} is already in use`);
  
  // Check if it's likely another OpenDia instance
  const isOpenDia = await checkIfOpenDiaProcess(port);
  
  if (isOpenDia) {
    console.error(`🔍 Detected existing OpenDia instance on port ${port} (this should not happen after cleanup)`);
    console.error(`⚠️  Attempting to kill remaining process...`);
    await killExistingOpenDia(port);
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check if port is now free
    const stillInUse = await checkPortInUse(port);
    if (!stillInUse) {
      console.error(`✅ Port ${port} is now available`);
      return port;
    }
    
    // If still in use, find alternative port
    const altPort = await findAvailablePort(port + 1);
    console.error(`🔄 Port ${port} still busy, using port ${altPort}`);
    if (portName === 'WebSocket') {
      console.error(`💡 Update Chrome/Firefox extension to: ws://localhost:${altPort}`);
    }
    return altPort;
  } else {
    // Something else is using the port - auto-increment
    const altPort = await findAvailablePort(port + 1);
    console.error(`🔄 ${portName} port ${port} busy (non-OpenDia), using port ${altPort}`);
    if (portName === 'WebSocket') {
      console.error(`💡 Update Chrome/Firefox extension to: ws://localhost:${altPort}`);
    }
    return altPort;
  }
}

// Express app setup
const app = express();

// Loopback is not a trust boundary for a browser: a page the user visits can
// reach 127.0.0.1 too. Same rule the WebSocket handshake uses — a page announces
// itself with an http(s) Origin (or "null" when sandboxed) and is refused, while
// extension service workers send an extension-scheme Origin and non-browser MCP
// clients send none.
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//;

function isAllowedOrigin(origin) {
  return !origin || EXTENSION_ORIGIN.test(origin);
}

// Never reflect `*`, or a page could read the response to a request it is
// allowed to send. Denying the origin only omits the header; the hard refusal is
// guardOrigin below, so a simple request that skips preflight is still blocked.
app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  allowedHeaders: ['Content-Type', 'Cache-Control', 'Authorization'],
  methods: ['GET', 'POST', 'OPTIONS']
}));

function guardOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin)) {
    console.error(`🚫 Rejected ${req.method} ${req.path} from origin ${origin}`);
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireToken(req, res, next) {
  if (!AUTH_TOKEN) return next();

  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!provided || !timingSafeEqual(provided, AUTH_TOKEN)) {
    console.error(`🚫 Rejected ${req.method} ${req.path} — missing or bad token`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

app.use(guardOrigin);
app.use(express.json());

// WebSocket server for Chrome/Firefox Extension (will be initialized after port conflict resolution)
let wss = null;
let chromeExtensionSocket = null;
let availableTools = [];

// Tool call tracking
const pendingCalls = new Map();
// Monotonic counter so concurrent tool calls can never share a call id.
let callIdCounter = 0;

// Simple MCP protocol implementation over stdio
async function handleMCPRequest(request) {
  const { method, params, id } = request;

  // Handle notifications (no id means it's a notification)
  if (!id && method && method.startsWith("notifications/")) {
    console.error(`Received notification: ${method}`);
    return null; // No response needed for notifications
  }

  // Handle requests that don't need implementation
  if (id === undefined || id === null) {
    return null; // No response for notifications
  }

  try {
    let result;

    switch (method) {
      case "initialize":
        // RESPOND IMMEDIATELY - don't wait for extension
        console.error(
          `MCP client initializing: ${params?.clientInfo?.name || "unknown"}`
        );
        result = {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "browser-mcp-server",
            version: "2.0.0",
          },
          instructions:
            "🎯 Enhanced browser automation with anti-detection bypass for Twitter/X, LinkedIn, Facebook. Extension may take a moment to connect.",
        };
        break;

      case "tools/list":
        // Debug logging
        console.error(
          `Tools/list called. Extension connected: ${
            chromeExtensionSocket &&
            chromeExtensionSocket.readyState === WebSocket.OPEN
          }, Available tools: ${availableTools.length}`
        );

        // Return tools from extension if available, otherwise fallback tools
        if (
          chromeExtensionSocket &&
          chromeExtensionSocket.readyState === WebSocket.OPEN &&
          availableTools.length > 0
        ) {
          console.error(
            `Returning ${availableTools.length} tools from extension`
          );
          result = {
            tools: availableTools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          };
        } else {
          // Return basic fallback tools
          console.error("Extension not connected, returning fallback tools");
          result = {
            tools: getFallbackTools(),
          };
        }
        break;

      case "tools/call":
        if (
          !chromeExtensionSocket ||
          chromeExtensionSocket.readyState !== WebSocket.OPEN
        ) {
          // Extension not connected - return helpful error
          result = {
            content: [
              {
                type: "text",
                text: "❌ Browser Extension not connected. Please install and activate the browser extension, then try again.\n\nSetup instructions:\n\nFor Chrome: \n1. Go to chrome://extensions/\n2. Enable Developer mode\n3. Click 'Load unpacked' and select the Chrome extension folder\n\nFor Firefox:\n1. Go to about:debugging#/runtime/this-firefox\n2. Click 'Load Temporary Add-on...'\n3. Select the manifest-firefox.json file\n\n🎯 Features: Anti-detection bypass for Twitter/X, LinkedIn, Facebook + universal automation",
              },
            ],
            isError: true,
          };
        } else {
          // Extension connected - try the tool call
          try {
            const toolResult = await callBrowserTool(
              params.name,
              params.arguments || {}
            );

            // Format response based on tool type
            const formattedResult = formatToolResult(params.name, toolResult);

            result = {
              content: [
                {
                  type: "text",
                  text: formattedResult,
                },
              ],
              isError: false,
            };
          } catch (error) {
            result = {
              content: [
                {
                  type: "text",
                  text: `❌ Tool execution failed: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }
        break;

      case "resources/list":
        // Return empty resources list
        result = { resources: [] };
        break;



      default:
        throw new Error(`Unknown method: ${method}`);
    }

    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error.message,
      },
    };
  }
}

// Enhanced tool result formatting with anti-detection support
function formatToolResult(toolName, result) {
  const metadata = {
    tool: toolName,
    execution_time: result.execution_time || 0,
    timestamp: new Date().toISOString(),
  };

  switch (toolName) {
    case "page_analyze":
      return formatPageAnalyzeResult(result, metadata);

    case "page_extract_content":
      return formatContentExtractionResult(result, metadata);

    case "element_click":
      return formatElementClickResult(result, metadata);

    case "element_fill":
      return formatElementFillResult(result, metadata);

    case "page_navigate":
      return `${result.warning ? `⚠️ ${result.warning}` : `✅ Successfully navigated to: ${
        result.url || "unknown URL"
      }`}\n\n${JSON.stringify(metadata, null, 2)}`;

    case "page_wait_for":
      return (
        `✅ Condition met: ${result.condition_type || "unknown"}\n` +
        `Wait time: ${result.wait_time || 0}ms\n\n${JSON.stringify(
          metadata,
          null,
          2
        )}`
      );

    case "get_history":
      return formatHistoryResult(result, metadata);

    case "get_selected_text":
      return formatSelectedTextResult(result, metadata);

    case "page_scroll":
      return formatScrollResult(result, metadata);

    case "get_page_links":
      return formatLinksResult(result, metadata);

    case "tab_create":
      return formatTabCreateResult(result, metadata);

    case "tab_close":
      return formatTabCloseResult(result, metadata);

    case "tab_list":
      return formatTabListResult(result, metadata);

    case "tab_switch":
      return formatTabSwitchResult(result, metadata);

    case "element_get_state":
      return formatElementStateResult(result, metadata);

    case "page_style":
      return formatPageStyleResult(result, metadata);

    default:
      // Legacy tools or unknown tools
      return JSON.stringify(result, null, 2);
  }
}

function formatPageAnalyzeResult(result, metadata) {
  if (result.elements && result.elements.length > 0) {
    const platformInfo = result.summary?.anti_detection_platform
      ? `\n🎯 Anti-detection platform detected: ${result.summary.anti_detection_platform}`
      : "";

    const summary =
      `Found ${result.elements.length} relevant elements using ${result.method}:${platformInfo}\n\n` +
      result.elements
        .map((el) => {
          const readyStatus = el.ready ? "✅ Ready" : "⚠️ Not ready";
          const stateInfo = el.state === "disabled" ? " (disabled)" : "";
          return `• ${el.name} (${el.type}) - Confidence: ${el.conf}% ${readyStatus}${stateInfo}\n  Element ID: ${el.id}`;
        })
        .join("\n\n");
    return `${summary}\n\n${JSON.stringify(metadata, null, 2)}`;
  } else {
    const intentHint = result.intent_hint || "unknown";
    const platformInfo = result.summary?.anti_detection_platform
      ? `\nPlatform: ${result.summary.anti_detection_platform}`
      : "";
    return `No relevant elements found for intent: "${intentHint}"${platformInfo}\n\n${JSON.stringify(
      metadata,
      null,
      2
    )}`;
  }
}

function formatContentExtractionResult(result, metadata) {
  const contentSummary = `Extracted ${result.content_type} content using ${result.method}:\n\n`;
  if (result.content) {
    // Check if this is full content extraction (summarize=false) or summary
    // If it's a content object with properties, show full content
    // If it's a string or small content, it's probably summarized
    let preview;
    if (typeof result.content === "string") {
      // String content - likely summarized, keep truncation
      preview = result.content.substring(0, 500) + (result.content.length > 500 ? "..." : "");
    } else if (result.content && typeof result.content === "object") {
      // Object content - check if it's full content extraction
      if (result.content.content && result.content.content.length > 1000) {
        // This looks like full content extraction - don't truncate
        preview = JSON.stringify(result.content, null, 2);
      } else {
        // Smaller content, apply truncation
        preview = JSON.stringify(result.content, null, 2).substring(0, 500);
      }
    } else {
      // Fallback
      preview = JSON.stringify(result.content, null, 2).substring(0, 500);
    }
    
    return `${contentSummary}${preview}\n\n${JSON.stringify(
      metadata,
      null,
      2
    )}`;
  } else if (result.summary) {
    // Enhanced summarized content response
    const summaryText = formatContentSummary(
      result.summary,
      result.content_type
    );
    return `${contentSummary}${summaryText}\n\n${JSON.stringify(
      metadata,
      null,
      2
    )}`;
  } else {
    return `${contentSummary}No content found\n\n${JSON.stringify(
      metadata,
      null,
      2
    )}`;
  }
}

function formatContentSummary(summary, contentType) {
  switch (contentType) {
    case "article":
      return (
        `📰 Article: "${summary.title}"\n` +
        `📝 Word count: ${summary.word_count}\n` +
        `⏱️ Reading time: ${summary.reading_time} minutes\n` +
        `🖼️ Has media: ${summary.has_images || summary.has_videos}\n` +
        `Preview: ${summary.preview}`
      );

    case "search_results":
      return (
        `🔍 Search Results Summary:\n` +
        `📊 Total results: ${summary.total_results}\n` +
        `🏆 Quality score: ${summary.quality_score}/100\n` +
        `📈 Average relevance: ${Math.round(summary.avg_score * 100)}%\n` +
        `🌐 Top domains: ${summary.top_domains
          ?.map((d) => d.domain)
          .join(", ")}\n` +
        `📝 Result types: ${summary.result_types?.join(", ")}`
      );

    case "posts":
      return (
        `📱 Social Posts Summary:\n` +
        `📊 Post count: ${summary.post_count}\n` +
        `📝 Average length: ${summary.avg_length} characters\n` +
        `❤️ Total engagement: ${summary.engagement_total}\n` +
        `🖼️ Posts with media: ${summary.has_media_count}\n` +
        `👥 Unique authors: ${summary.authors}\n` +
        `📋 Post types: ${summary.post_types?.join(", ")}`
      );

    default:
      return JSON.stringify(summary, null, 2);
  }
}

function formatElementClickResult(result, metadata) {
  return (
    `✅ Successfully clicked element: ${
      result.element_name || result.element_id
    }\n` +
    `Click type: ${result.click_type || "left"}\n\n${JSON.stringify(
      metadata,
      null,
      2
    )}`
  );
}

function formatElementFillResult(result, metadata) {
  // Enhanced formatting for anti-detection bypass methods
  const methodEmojis = {
    twitter_direct_bypass: "🐦 Twitter Direct Bypass",
    linkedin_direct_bypass: "💼 LinkedIn Direct Bypass",
    facebook_direct_bypass: "📘 Facebook Direct Bypass",
    generic_direct_bypass: "🎯 Generic Direct Bypass",
    standard_fill: "🔧 Standard Fill",
    anti_detection_bypass: "🛡️ Anti-Detection Bypass",
  };

  const methodDisplay = methodEmojis[result.method] || result.method;
  const successIcon = result.success ? "✅" : "❌";

  let fillResult = `${successIcon} Element fill ${
    result.success ? "completed" : "failed"
  } using ${methodDisplay}\n`;
  fillResult += `📝 Target: ${result.element_name || result.element_id}\n`;
  fillResult += `💬 Input: "${result.value}"\n`;

  if (result.actual_value) {
    fillResult += `📄 Result: "${result.actual_value}"\n`;
  }

  // Add bypass-specific information
  if (
    result.method?.includes("bypass") &&
    result.execCommand_result !== undefined
  ) {
    fillResult += `🔧 execCommand success: ${result.execCommand_result}\n`;
  }

  if (!result.success && result.method?.includes("bypass")) {
    fillResult += `\n⚠️ Direct bypass failed - page may have enhanced detection. Try refreshing the page.\n`;
  }

  return `${fillResult}\n${JSON.stringify(metadata, null, 2)}`;
}

function formatHistoryResult(result, metadata) {
  if (!result.history_items || result.history_items.length === 0) {
    return `🕒 No history items found matching the criteria\n\n${JSON.stringify(metadata, null, 2)}`;
  }

  const summary = `🕒 Found ${result.history_items.length} history items (${result.metadata.total_found} total matches):\n\n`;
  
  const items = result.history_items.map((item, index) => {
    const visitInfo = `Visits: ${item.visit_count}`;
    const timeInfo = new Date(item.last_visit_time).toLocaleDateString();
    const domainInfo = `[${item.domain}]`;
    
    return `${index + 1}. **${item.title}**\n   ${domainInfo} ${visitInfo} | Last: ${timeInfo}\n   URL: ${item.url}`;
  }).join('\n\n');

  const searchSummary = result.metadata.search_params.keywords ?
    `\n🔍 Search: "${result.metadata.search_params.keywords}"` : '';
  const dateSummary = result.metadata.search_params.date_range ?
    `\n📅 Date range: ${result.metadata.search_params.date_range}` : '';
  const domainSummary = result.metadata.search_params.domains ?
    `\n🌐 Domains: ${result.metadata.search_params.domains.join(', ')}` : '';
  const visitSummary = result.metadata.search_params.min_visit_count > 1 ?
    `\n📊 Min visits: ${result.metadata.search_params.min_visit_count}` : '';

  return `${summary}${items}${searchSummary}${dateSummary}${domainSummary}${visitSummary}\n\n${JSON.stringify(metadata, null, 2)}`;
}

function formatSelectedTextResult(result, metadata) {
  if (!result.has_selection) {
    return `📝 No text selected\n\n${result.message || "No text is currently selected on the page"}\n\n${JSON.stringify(metadata, null, 2)}`;
  }

  const textPreview = result.selected_text.length > 200
    ? result.selected_text.substring(0, 200) + "..."
    : result.selected_text;

  let summary = `📝 Selected Text (${result.character_count} characters):\n\n"${textPreview}"`;
  
  if (result.truncated) {
    summary += `\n\n⚠️ Text was truncated to fit length limit`;
  }

  if (result.selection_metadata) {
    const meta = result.selection_metadata;
    summary += `\n\n📊 Selection Details:`;
    summary += `\n• Word count: ${meta.word_count}`;
    summary += `\n• Line count: ${meta.line_count}`;
    summary += `\n• Position: ${Math.round(meta.position.x)}, ${Math.round(meta.position.y)}`;
    
    if (meta.parent_element.tag_name) {
      summary += `\n• Parent element: <${meta.parent_element.tag_name}>`;
      if (meta.parent_element.class_name) {
        summary += ` class="${meta.parent_element.class_name}"`;
      }
    }
    
    if (meta.page_info) {
      summary += `\n• Page: ${meta.page_info.title}`;
      summary += `\n• Domain: ${meta.page_info.domain}`;
    }
  }

  return `${summary}\n\n${JSON.stringify(metadata, null, 2)}`;
}

function formatScrollResult(result, metadata) {
  if (!result.success) {
    return `📜 Scroll failed: ${result.error || "Unknown error"}\n\n${JSON.stringify(metadata, null, 2)}`;
  }

  let summary = `📜 Page scrolled successfully`;
  
  if (result.direction) {
    summary += ` ${result.direction}`;
  }
  
  if (result.amount && result.amount !== "custom") {
    summary += ` (${result.amount})`;
  } else if (result.pixels) {
    summary += ` (${result.pixels}px)`;
  }

  if (result.element_scrolled) {
    summary += `\n🎯 Scrolled to element: ${result.element_scrolled}`;
  }

  if (result.scroll_position) {
    summary += `\n📍 New position: x=${result.scroll_position.x}, y=${result.scroll_position.y}`;
  }

  if (result.page_dimensions) {
    const { width, height, scrollWidth, scrollHeight } = result.page_dimensions;
    summary += `\n📐 Page size: ${width}x${height} (scrollable: ${scrollWidth}x${scrollHeight})`;
  }

  if (result.wait_time) {
    summary += `\n⏱️ Waited ${result.wait_time}ms after scroll`;
  }

  return `${summary}\n\n${JSON.stringify(metadata, null, 2)}`;
}

function formatLinksResult(result, metadata) {
  if (!result.links || result.links.length === 0) {
    return `🔗 No links found on the page\n\n${JSON.stringify(metadata, null, 2)}`;
  }

  const summary = `🔗 Found ${result.returned} links (${result.total_found} total on page):\n`;
  const currentDomain = result.current_domain ? `\n🌐 Current domain: ${result.current_domain}` : '';
  
  const linksList = result.links.map((link, index) => {
    const typeIcon = link.type === 'internal' ? '🏠' : '🌐';
    const linkText = link.text.length > 50 ? link.text.substring(0, 50) + '...' : link.text;
    const displayText = linkText || '[No text]';
    const title = link.title ? `\n   Title: ${link.title}` : '';
    const domain = link.domain ? ` [${link.domain}]` : '';
    
    return `${index + 1}. ${typeIcon} **${displayText}**${domain}${title}\n   URL: ${link.url}`;
  }).join('\n\n');

  const filterInfo = [];
  if (result.links.some(l => l.type === 'internal') && result.links.some(l => l.type === 'external')) {
    const internal = result.links.filter(l => l.type === 'internal').length;
    const external = result.links.filter(l => l.type === 'external').length;
    filterInfo.push(`📊 Internal: ${internal}, External: ${external}`);
  }
  
  const filterSummary = filterInfo.length > 0 ? `\n${filterInfo.join('\n')}` : '';
  
  return `${summary}${currentDomain}${filterSummary}\n\n${linksList}\n\n${JSON.stringify(metadata, null, 2)}`;
}

function formatTabCreateResult(result, metadata) {
  // Handle batch operations
  if (result.batch_operation) {
    const { summary, created_tabs, warnings, errors } = result;
    
    let output = `🚀 Batch tab creation completed
📊 Summary: ${summary.successful}/${summary.total_requested} tabs created successfully
⏱️ Execution time: ${summary.execution_time_ms}ms
📦 Chunks processed: ${summary.chunks_processed}

`;

    // Add warnings if any
    if (warnings && warnings.length > 0) {
      output += `⚠️ Warnings:\n${warnings.map(w => `   • ${w}`).join('\n')}\n\n`;
    }

    // Add created tabs info
    if (created_tabs && created_tabs.length > 0) {
      output += `✅ Created tabs:\n`;
      created_tabs.forEach((tab, index) => {
        output += `   ${index + 1}. ${tab.title || 'New Tab'} (ID: ${tab.tab_id})\n`;
        output += `      🌐 ${tab.actual_url || tab.url}\n`;
        if (tab.active) output += `      🎯 Active tab\n`;
      });
      output += '\n';
    }

    // Add errors if any
    if (errors && errors.length > 0) {
      output += `❌ Errors:\n`;
      errors.forEach((error, index) => {
        output += `   ${index + 1}. ${error.url}: ${error.error}\n`;
      });
      output += '\n';
    }

    return output + `\n${JSON.stringify(metadata, null, 2)}`;
  }

  // Handle single tab operations (existing logic)
  if (result.success) {
    return `✅ New tab created successfully
🆔 Tab ID: ${result.tab_id}
🌐 URL: ${result.url || 'about:blank'}
🎯 Active: ${result.active ? 'Yes' : 'No'}
📝 Title: ${result.title || 'New Tab'}
${result.warning ? `⚠️ Warning: ${result.warning}` : ''}

${JSON.stringify(metadata, null, 2)}`;
  } else {
    return `❌ Failed to create tab: ${result.error || 'Unknown error'}

${JSON.stringify(metadata, null, 2)}`;
  }
}

function formatTabCloseResult(result, metadata) {
  if (result.success) {
    const tabText = result.count === 1 ? 'tab' : 'tabs';
    return `✅ Successfully closed ${result.count} ${tabText}
🆔 Closed tab IDs: ${result.closed_tabs.join(', ')}

${JSON.stringify(metadata, null, 2)}`;
  } else {
    return `❌ Failed to close tabs: ${result.error || 'Unknown error'}

${JSON.stringify(metadata, null, 2)}`;
  }
}

function formatTabListResult(result, metadata) {
  if (!result.success || !result.tabs || result.tabs.length === 0) {
    return `📋 No tabs found

${JSON.stringify(metadata, null, 2)}`;
  }

  const summary = `📋 Found ${result.count} open tabs:
🎯 Active tab: ${result.active_tab || 'None'}

`;
  
  const tabsList = result.tabs.map((tab, index) => {
    const activeIcon = tab.active ? '🟢' : '⚪';
    const statusInfo = tab.status ? ` [${tab.status}]` : '';
    const pinnedInfo = tab.pinned ? ' 📌' : '';
    
    return `${index + 1}. ${activeIcon} **${tab.title}**${pinnedInfo}${statusInfo}
   🆔 ID: ${tab.id} | 🌐 ${tab.url}`;
  }).join('\n\n');

  return `${summary}${tabsList}

${JSON.stringify(metadata, null, 2)}`;
}

function formatTabSwitchResult(result, metadata) {
  if (result.success) {
    return `✅ Successfully switched to tab
🆔 Tab ID: ${result.tab_id}
📝 Title: ${result.title}
🌐 URL: ${result.url}
🏠 Window ID: ${result.window_id}

${JSON.stringify(metadata, null, 2)}`;
  } else {
    return `❌ Failed to switch tabs: ${result.error || 'Unknown error'}

${JSON.stringify(metadata, null, 2)}`;
  }
}

function formatElementStateResult(result, metadata) {
  const element = result.element_name || result.element_id || 'Unknown element';
  const state = result.state || {};
  
  let summary = `🔍 Element State: ${element}

📊 **Interaction Readiness**: ${state.interaction_ready ? '✅ Ready' : '❌ Not Ready'}

**Detailed State:**
• Disabled: ${state.disabled ? '❌ Yes' : '✅ No'}
• Visible: ${state.visible ? '✅ Yes' : '❌ No'}
• Clickable: ${state.clickable ? '✅ Yes' : '❌ No'}
• Focusable: ${state.focusable ? '✅ Yes' : '❌ No'}
• Has Text: ${state.hasText ? '✅ Yes' : '❌ No'}
• Is Empty: ${state.isEmpty ? '❌ Yes' : '✅ No'}`;

  if (result.current_value) {
    summary += `
📝 **Current Value**: "${result.current_value}"`;
  }

  return `${summary}

${JSON.stringify(metadata, null, 2)}`;
}

function formatPageStyleResult(result, metadata) {
  const successIcon = result.success ? '✅' : '❌';
  const statusText = result.success ? 'successfully applied' : 'failed to apply';
  
  let summary = `🎨 Page styling ${statusText}\n\n`;
  
  summary += `📄 **Operation Details:**\n`;
  summary += `• **Mode:** ${result.mode || 'Unknown'}\n`;
  
  if (result.theme) {
    summary += `• **Theme:** ${result.theme}\n`;
  }
  
  if (result.applied_css !== undefined) {
    summary += `• **CSS Applied:** ${result.applied_css} characters\n`;
  }
  
  if (result.description) {
    summary += `• **Result:** ${result.description}\n`;
  }
  
  if (result.remember_enabled) {
    summary += `• **Saved:** Style preferences saved for this domain\n`;
  }
  
  if (result.effect_duration) {
    summary += `• **Effect Duration:** ${result.effect_duration} seconds\n`;
  }
  
  if (result.mood) {
    summary += `• **Mood Applied:** "${result.mood}"\n`;
  }
  
  if (result.intensity) {
    summary += `• **Intensity:** ${result.intensity}\n`;
  }
  
  if (!result.success && result.error) {
    summary += `\n❌ **Error:** ${result.error}\n`;
  }
  
  if (result.warning) {
    summary += `\n⚠️ **Warning:** ${result.warning}\n`;
  }
  
  summary += `\n💡 **Tip:** Use mode="reset" to restore original page styling`;
  
  return `${summary}\n\n${JSON.stringify(metadata, null, 2)}`;
}

// Enhanced fallback tools when extension is not connected
function getFallbackTools() {
  return [
    {
      name: "page_analyze",
      description:
        "🔍 BACKGROUND TAB READY: Analyze any tab without switching! Two-phase intelligent page analysis with token efficiency optimization. Use tab_id parameter to analyze background tabs while staying on current page. (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          intent_hint: {
            type: "string",
            description:
              "What user wants to do: post_tweet, search, login, etc.",
          },
          phase: {
            type: "string",
            enum: ["discover", "detailed"],
            default: "discover",
            description:
              "Analysis phase: 'discover' for quick scan, 'detailed' for full analysis",
          },
        },
        required: ["intent_hint"],
      },
    },
    {
      name: "page_extract_content",
      description:
        "📄 BACKGROUND TAB READY: Extract content from any tab without switching! Perfect for analyzing multiple research tabs, articles, or pages simultaneously. Use tab_id to target specific background tabs. (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          content_type: {
            type: "string",
            enum: ["article", "search_results", "posts"],
            description: "Type of content to extract",
          },
          summarize: {
            type: "boolean",
            default: true,
            description:
              "Return summary instead of full content (saves tokens)",
          },
        },
        required: ["content_type"],
      },
    },
    {
      name: "element_click",
      description:
        "🖱️ BACKGROUND TAB READY: Click elements in any tab without switching! Perform actions on background tabs while staying on current page. Use tab_id to target specific tabs. (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description: "Element ID from page_analyze",
          },
          click_type: {
            type: "string",
            enum: ["left", "right", "double"],
            default: "left",
          },
        },
        required: ["element_id"],
      },
    },
    {
      name: "element_fill",
      description:
        "✏️ BACKGROUND TAB READY: Fill forms in any tab without switching! Enhanced focus and event simulation for modern web apps with anti-detection bypass for Twitter/X, LinkedIn, Facebook. Use tab_id to fill forms in background tabs. (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description: "Element ID from page_analyze",
          },
          value: {
            type: "string",
            description: "Text to input",
          },
          clear_first: {
            type: "boolean",
            default: true,
            description: "Clear existing content before filling",
          },
        },
        required: ["element_id", "value"],
      },
    },
    {
      name: "page_navigate",
      description:
        "🧭 Navigate to URLs with wait conditions (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to" },
          wait_for: {
            type: "string",
            description: "CSS selector to wait for after navigation",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "page_wait_for",
      description: "⏳ Wait for elements or conditions (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          condition_type: {
            type: "string",
            enum: ["element_visible", "text_present"],
            description: "Type of condition to wait for",
          },
          selector: {
            type: "string",
            description: "CSS selector (for element_visible condition)",
          },
          text: {
            type: "string",
            description: "Text to wait for (for text_present condition)",
          },
        },
        required: ["condition_type"],
      },
    },
    // Tab Management Tools
    {
      name: "tab_create",
      description: "Creates tabs. CRITICAL: For multiple identical tabs, ALWAYS use 'count' parameter! Examples: {url: 'https://x.com', count: 5} creates 5 Twitter tabs. {url: 'https://github.com', count: 10} creates 10 GitHub tabs. Single tab: {url: 'https://example.com'}. Multiple different URLs: {urls: ['url1', 'url2']}.",
      inputSchema: {
        type: "object",
        examples: [
          { url: "https://x.com", count: 5 },  // CORRECT: Creates 5 identical Twitter tabs in one batch
          { url: "https://github.com", count: 10 },  // CORRECT: Creates 10 GitHub tabs 
          { urls: ["https://x.com/post1", "https://x.com/post2", "https://google.com"] },  // CORRECT: Different URLs in batch
          { url: "https://example.com" }  // Single tab only
        ],
        properties: {
          url: {
            type: "string",
            description: "Single URL to open. Can be used with 'count' to create multiple identical tabs"
          },
          urls: {
            type: "array",
            items: { type: "string" },
            description: "PREFERRED FOR MULTIPLE URLS: Array of URLs to open ALL AT ONCE in a single batch operation. Pass ALL URLs here instead of making multiple calls! Example: ['https://x.com/post1', 'https://x.com/post2', 'https://google.com']",
            maxItems: 100
          },
          count: {
            type: "number",
            default: 1,
            minimum: 1,
            maximum: 50,
            description: "REQUIRED FOR MULTIPLE IDENTICAL TABS: Set this to N to create N copies of the same URL. For '5 Twitter tabs' use count=5 with url='https://x.com'. DO NOT make 5 separate calls!"
          },
          active: {
            type: "boolean",
            default: true,
            description: "Whether to activate the last created tab (single tab only)"
          },
          wait_for: {
            type: "string",
            description: "CSS selector to wait for after tab creation (single tab only)"
          },
          timeout: {
            type: "number",
            default: 10000,
            description: "Maximum wait time per tab in milliseconds"
          },
          batch_settings: {
            type: "object",
            description: "Performance control settings for batch operations",
            properties: {
              chunk_size: {
                type: "number",
                default: 5,
                minimum: 1,
                maximum: 10,
                description: "Number of tabs to create per batch"
              },
              delay_between_chunks: {
                type: "number",
                default: 1000,
                minimum: 100,
                maximum: 5000,
                description: "Delay between batches in milliseconds"
              },
              delay_between_tabs: {
                type: "number",
                default: 200,
                minimum: 50,
                maximum: 1000,
                description: "Delay between individual tabs in milliseconds"
              }
            }
          }
        }
      }
    },
    {
      name: "tab_close",
      description: "❌ Close specific tab(s) by ID or close current tab (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: {
            type: "number",
            description: "Specific tab ID to close (optional, closes current tab if not provided)"
          },
          tab_ids: {
            type: "array",
            items: { type: "number" },
            description: "Array of tab IDs to close multiple tabs"
          }
        }
      }
    },
    {
      name: "tab_list",
      description: "📋 TAB DISCOVERY: Get list of all open tabs with IDs for background tab targeting! Shows content script readiness status and tab details. Essential for multi-tab workflows - use tab IDs with other tools to work on background tabs. (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          current_window_only: {
            type: "boolean",
            default: true,
            description: "Only return tabs from the current window"
          },
          include_details: {
            type: "boolean",
            default: true,
            description: "Include additional tab details (title, favicon, etc.)"
          }
        }
      }
    },
    {
      name: "tab_switch",
      description: "🔄 Switch to a specific tab by ID (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: {
            type: "number",
            description: "Tab ID to switch to"
          }
        },
        required: ["tab_id"]
      }
    },
    // Element State Tools
    {
      name: "element_get_state",
      description: "🔍 Get detailed state information for a specific element (disabled, clickable, etc.) (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description: "Element ID from page_analyze"
          }
        },
        required: ["element_id"]
      }
    },
    // Workspace and Reference Management Tools
    {
      name: "get_bookmarks",
      description: "Get all bookmarks or search for specific bookmarks (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query for bookmarks (optional)"
          }
        }
      }
    },
    {
      name: "add_bookmark",
      description: "Add a new bookmark (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Title of the bookmark"
          },
          url: {
            type: "string",
            description: "URL of the bookmark"
          },
          parentId: {
            type: "string",
            description: "ID of the parent folder (optional)"
          }
        },
        required: ["title", "url"]
      }
    },
    {
      name: "get_history",
      description: "🕒 Search browser history with comprehensive filters for finding previous work (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          keywords: {
            type: "string",
            description: "Search keywords to match in page titles and URLs"
          },
          start_date: {
            type: "string",
            format: "date-time",
            description: "Start date for history search (ISO 8601 format)"
          },
          end_date: {
            type: "string",
            format: "date-time",
            description: "End date for history search (ISO 8601 format)"
          },
          domains: {
            type: "array",
            items: { type: "string" },
            description: "Filter by specific domains"
          },
          min_visit_count: {
            type: "number",
            default: 1,
            description: "Minimum visit count threshold"
          },
          max_results: {
            type: "number",
            default: 50,
            maximum: 500,
            description: "Maximum number of results to return"
          },
          sort_by: {
            type: "string",
            enum: ["visit_time", "visit_count", "title"],
            default: "visit_time",
            description: "Sort results by visit time, visit count, or title"
          },
          sort_order: {
            type: "string",
            enum: ["desc", "asc"],
            default: "desc",
            description: "Sort order"
          }
        }
      }
    },
    {
      name: "get_selected_text",
      description: "📝 BACKGROUND TAB READY: Get selected text from any tab without switching! Perfect for collecting quotes, citations, or highlighted content from multiple research tabs simultaneously. (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          include_metadata: {
            type: "boolean",
            default: true,
            description: "Include metadata about the selection (element info, position, etc.)"
          },
          max_length: {
            type: "number",
            default: 10000,
            description: "Maximum length of text to return"
          }
        }
      }
    },
    {
      name: "page_scroll",
      description: "📜 BACKGROUND TAB READY: Scroll any tab without switching! Critical for long pages. Navigate through content in background tabs while staying on current page. Use tab_id to target specific tabs. (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right", "top", "bottom"],
            default: "down",
            description: "Direction to scroll"
          },
          amount: {
            type: "string",
            enum: ["small", "medium", "large", "page", "custom"],
            default: "medium",
            description: "Amount to scroll"
          },
          pixels: {
            type: "number",
            description: "Custom pixel amount (when amount is 'custom')"
          },
          smooth: {
            type: "boolean",
            default: true,
            description: "Use smooth scrolling animation"
          },
          element_id: {
            type: "string",
            description: "Scroll to specific element (overrides direction/amount)"
          },
          wait_after: {
            type: "number",
            default: 500,
            description: "Milliseconds to wait after scrolling"
          }
        }
      }
    },
    {
      name: "get_page_links",
      description: "🔗 Get all hyperlinks on the current page with smart filtering (Extension required)",
      inputSchema: {
        type: "object",
        properties: {
          include_internal: {
            type: "boolean",
            default: true,
            description: "Include internal links (same domain)"
          },
          include_external: {
            type: "boolean",
            default: true,
            description: "Include external links (different domains)"
          },
          domain_filter: {
            type: "string",
            description: "Filter links to include only specific domain(s)"
          },
          max_results: {
            type: "number",
            default: 100,
            maximum: 500,
            description: "Maximum number of links to return"
          }
        }
      }
    },
    {
      name: "page_style",
      description: "🎨 Transform page appearance with themes, colors, fonts, and fun effects! Apply preset themes like 'dark_hacker', 'retro_80s', or create custom styles. Perfect for making boring pages fun or improving readability.",
      inputSchema: {
        type: "object",
        examples: [
          { mode: "preset", theme: "dark_hacker" },
          { mode: "custom", background: "#000", text_color: "#00ff00", font: "monospace" },
          { mode: "ai_mood", mood: "cozy coffee shop vibes", intensity: "strong" },
          { mode: "effect", effect: "matrix_rain", duration: 30 }
        ],
        properties: {
          mode: {
            type: "string", 
            enum: ["preset", "custom", "ai_mood", "effect", "reset"],
            description: "Styling mode to use"
          },
          theme: {
            type: "string",
            enum: ["dark_hacker", "retro_80s", "rainbow_party", "minimalist_zen", "high_contrast", "cyberpunk", "pastel_dream", "newspaper"],
            description: "Preset theme name (when mode=preset)"
          },
          background: { 
            type: "string", 
            description: "Background color/gradient" 
          },
          text_color: { 
            type: "string", 
            description: "Text color" 
          },
          font: { 
            type: "string", 
            description: "Font family" 
          },
          font_size: { 
            type: "string", 
            description: "Font size (e.g., '1.2em', '16px')" 
          },
          mood: { 
            type: "string", 
            description: "Describe desired mood/feeling (when mode=ai_mood)" 
          },
          intensity: { 
            type: "string", 
            enum: ["subtle", "medium", "strong"], 
            default: "medium" 
          },
          effect: { 
            type: "string", 
            enum: ["matrix_rain", "floating_particles", "cursor_trail", "neon_glow", "typing_effect"] 
          },
          duration: { 
            type: "number", 
            description: "Effect duration in seconds", 
            default: 10 
          },
          remember: { 
            type: "boolean", 
            description: "Remember this style for this website", 
            default: false 
          }
        },
        required: ["mode"]
      }
    },
  ];
}

// Call browser tool through Chrome/Firefox Extension
async function callBrowserTool(toolName, args) {
  if (
    !chromeExtensionSocket ||
    chromeExtensionSocket.readyState !== WebSocket.OPEN
  ) {
    throw new Error(
      "Browser Extension not connected. Make sure the extension is installed and active."
    );
  }

  // Date.now() alone collides when two calls fire in the same millisecond
  // (concurrent SSE POSTs, hybrid stdio+SSE, or parallel tool calls). A
  // collision overwrites the pending resolver, cross-wiring one call's
  // response onto another and leaving the loser to hit the 30s timeout.
  const callId = `${Date.now()}-${++callIdCounter}`;

  return new Promise((resolve, reject) => {
    // Track the timeout on the pending entry so it can be cleared when a
    // response arrives or the extension disconnects — otherwise every call
    // leaks a 30s timer until it fires.
    const timeout = setTimeout(() => {
      if (pendingCalls.has(callId)) {
        pendingCalls.delete(callId);
        reject(new Error("Tool call timeout"));
      }
    }, 30000);

    pendingCalls.set(callId, { resolve, reject, timeout });

    chromeExtensionSocket.send(
      JSON.stringify({
        id: callId,
        method: toolName,
        params: args,
      })
    );
  });
}

// Handle tool responses from Chrome/Firefox Extension
function handleToolResponse(message) {
  const pending = pendingCalls.get(message.id);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingCalls.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }
}

// Gate the control-channel handshake.
//
// The loopback bind already keeps other machines out. This closes the remaining
// hole: a web page the user visits can also reach 127.0.0.1, and a page that
// connects would be handed the extension's slot. Browsers always send Origin on
// a cross-origin WebSocket handshake, so a page announces itself as http(s).
// Extension service workers send an extension-scheme Origin; local non-browser
// clients (test-extension.js) send none.
function isLoopback(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function verifyExtensionClient(info, done) {
  const remote = info.req.socket.remoteAddress;
  if (!isLoopback(remote)) {
    console.error(`🚫 Rejected WebSocket handshake from non-loopback ${remote}`);
    return done(false, 403, "Forbidden");
  }

  const origin = info.origin || info.req.headers.origin;
  if (origin && !EXTENSION_ORIGIN.test(origin)) {
    console.error(`🚫 Rejected WebSocket handshake from origin ${origin}`);
    return done(false, 403, "Forbidden");
  }

  return done(true);
}

// Setup WebSocket connection handlers
function setupWebSocketHandlers() {
  wss.on("connection", (ws) => {
    // If an old extension socket is still tracked, close it before replacing
    // so the previous connection's close handler can't later null out the new one.
    if (chromeExtensionSocket && chromeExtensionSocket !== ws) {
      console.error("Replacing existing Browser Extension connection");
      try {
        chromeExtensionSocket.close();
      } catch (e) {
        // ignore — socket may already be half-closed
      }
    }

    console.error("Browser Extension connected");
    chromeExtensionSocket = ws;

    // Set up ping/pong for keepalive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data);

        if (message.type === "register") {
          // Any loopback client can send this. A non-array left availableTools
          // undefined and every later tools/list threw until restart.
          if (!Array.isArray(message.tools)) {
            console.error("⚠️ Ignoring register frame: tools is not an array");
            return;
          }
          availableTools = message.tools;
          console.error(
            `✅ Registered ${availableTools.length} browser tools from extension`
          );
          console.error(
            `🎯 Enhanced tools with anti-detection bypass: ${availableTools
              .map((t) => t.name)
              .join(", ")}`
          );
        } else if (message.type === "ping") {
          // Respond to ping with pong
          ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        } else if (message.id) {
          // Handle tool response
          handleToolResponse(message);
        }
      } catch (error) {
        console.error("Error processing message:", error);
      }
    });

    ws.on("close", () => {
      clearInterval(pingInterval);
      // Only clear tracked state if THIS socket is still the active one.
      // Without this guard, a stale close event from a previous connection
      // can null out a freshly reconnected extension and make the server
      // falsely report "extension not connected" until the user restarts.
      if (chromeExtensionSocket === ws) {
        console.error("Browser Extension disconnected");
        chromeExtensionSocket = null;
        availableTools = []; // Clear tools when extension disconnects
        // Reject any in-flight tool calls immediately so the MCP client
        // sees a real error instead of hanging for up to 30s waiting on
        // a socket that's gone.
        if (pendingCalls.size > 0) {
          console.error(
            `Rejecting ${pendingCalls.size} in-flight tool call(s) due to extension disconnect`
          );
          for (const pending of pendingCalls.values()) {
            clearTimeout(pending.timeout);
            pending.reject(
              new Error("Browser Extension disconnected mid-call")
            );
          }
          pendingCalls.clear();
        }
      } else {
        console.error("Stale Browser Extension socket closed (already replaced)");
      }
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });

    ws.on("pong", () => {
      // Extension is alive
    });
  });
}

// SSE/HTTP endpoints for online AI
app.route('/sse')
  .all(requireToken)
  .get((req, res) => {
    // SSE stream for connection
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    res.write(`data: ${JSON.stringify({
      type: 'connection',
      status: 'connected',
      server: 'OpenDia MCP Server',
      version: '1.0.0'
    })}\n\n`);

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`data: ${JSON.stringify({
        type: 'heartbeat',
        timestamp: Date.now()
      })}\n\n`);
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      console.error('SSE client disconnected');
    });

    console.error('SSE client connected');
  })
  .post(async (req, res) => {
    // MCP requests from online AI
    console.error('MCP request received via SSE:', req.body);

    try {
      // handleMCPRequest already returns a complete JSON-RPC response
      // (or null for notifications) — forward as-is, matching the stdio path.
      const response = await handleMCPRequest(req.body);
      if (response === null) {
        // JSON-RPC notification: no response body per spec
        res.status(204).end();
      } else {
        res.json(response);
      }
    } catch (error) {
      res.status(500).json({
        jsonrpc: "2.0",
        id: req.body?.id ?? null,
        error: { code: -32603, message: error.message }
      });
    }
  });

// Preflight is answered by the cors() middleware above, which reflects only
// allowed origins — a blanket handler here would hand `*` back to any page.

// Read from stdin
let inputBuffer = "";
if (!sseOnly) {
  process.stdin.on("data", async (chunk) => {
    inputBuffer += chunk.toString();

  // Process complete lines
  const lines = inputBuffer.split("\n");
  inputBuffer = lines.pop() || "";

  for (const line of lines) {
    if (line.trim()) {
      try {
        const request = JSON.parse(line);
        const response = await handleMCPRequest(request);

        // Only send response if one was generated (not for notifications)
        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      } catch (error) {
        console.error("Error processing request:", error);
      }
    }
  }
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    chromeExtensionConnected: chromeExtensionSocket !== null,
    availableTools: availableTools.length,
    transport: sseOnly ? 'sse-only' : 'hybrid',
    tunnelEnabled: enableTunnel,
    ports: {
      websocket: WS_PORT,
      http: HTTP_PORT
    },
    features: [
      'Anti-detection bypass for Twitter/X, LinkedIn, Facebook',
      'Two-phase intelligent page analysis',
      'Smart content extraction with summarization',
      'Element state detection and interaction readiness',
      'Performance analytics and token optimization',
      'SSE transport for online AI services'
    ]
  });
});

// Port discovery endpoint for the browser extension
app.get('/ports', (req, res) => {
  res.json({
    websocket: WS_PORT,
    http: HTTP_PORT,
    websocketUrl: `ws://localhost:${WS_PORT}`,
    httpUrl: `http://localhost:${HTTP_PORT}`,
    sseUrl: `http://localhost:${HTTP_PORT}/sse`
  });
});

// Server startup with port conflict resolution
async function startServer() {
  console.error("🚀 Enhanced Browser MCP Server with Anti-Detection Features");
  console.error(`📊 Default ports: WebSocket=${WS_PORT}, HTTP=${HTTP_PORT}`);
  
  // Always kill existing OpenDia processes on startup
  console.error('🔧 Checking for existing OpenDia processes...');
  const wsKilled = await killExistingOpenDia(WS_PORT);
  const httpKilled = await killExistingOpenDia(HTTP_PORT);
  
  if (wsKilled || httpKilled) {
    console.error('✅ Existing processes terminated');
    // Wait for ports to be fully released
    await new Promise(resolve => setTimeout(resolve, 2000));
  } else {
    console.error('ℹ️  No existing OpenDia processes found');
  }
  
  // Resolve port conflicts
  WS_PORT = await handlePortConflict(WS_PORT, 'WebSocket');
  HTTP_PORT = await handlePortConflict(HTTP_PORT, 'HTTP');
  
  // Ensure HTTP port doesn't conflict with resolved WebSocket port
  if (HTTP_PORT === WS_PORT) {
    HTTP_PORT = await findAvailablePort(WS_PORT + 1);
    console.error(`🔄 HTTP port adjusted to ${HTTP_PORT} to avoid WebSocket conflict`);
  }
  
  // Initialize WebSocket server after port resolution.
  // Bound to loopback: this socket is the browser-automation control channel, and
  // whoever holds it becomes chromeExtensionSocket (see setupWebSocketHandlers).
  // The extension connects to ws://localhost:5555 from the same machine, and the
  // optional ngrok tunnel forwards the HTTP port only, so nothing legitimate
  // needs this reachable off-host.
  wss = new WebSocket.Server({
    port: WS_PORT,
    host: "127.0.0.1",
    verifyClient: verifyExtensionClient,
  });
  
  // Set up WebSocket connection handling
  setupWebSocketHandlers();
  
  console.error(`✅ Ports resolved: WebSocket=${WS_PORT}, HTTP=${HTTP_PORT}`);
  
  // Start HTTP server
  const httpServer = app.listen(HTTP_PORT, HTTP_HOST, () => {
    console.error(`🌐 HTTP/SSE server running on ${HTTP_HOST}:${HTTP_PORT}`);
    console.error(`🔌 Browser Extension connects on ws://localhost:${WS_PORT}`);
    if (!isLoopbackHost(HTTP_HOST)) {
      console.error(`⚠️  Bound beyond loopback (--http-host=${HTTP_HOST}) — /sse requires the token below`);
    }
    if (AUTH_TOKEN) {
      console.error(`🔑 /sse token: ${AUTH_TOKEN}`);
      console.error('   Send it as: Authorization: Bearer <token>');
    }
    console.error("🎯 Features: Anti-detection bypass + intelligent automation");
  });

  // Auto-tunnel if requested
  if (enableTunnel) {
    try {
      console.error('🔄 Starting automatic tunnel...');
      
      // Use the system ngrok binary directly
      const ngrokProcess = spawn('ngrok', ['http', HTTP_PORT, '--log', 'stdout'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let tunnelUrl = null;
      
      // Wait for tunnel URL
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ngrokProcess.kill();
          reject(new Error('Tunnel startup timeout'));
        }, 10000);
        
        ngrokProcess.stdout.on('data', (data) => {
          const output = data.toString();
          const match = output.match(/url=https:\/\/[^\s]+/);
          if (match) {
            tunnelUrl = match[0].replace('url=', '');
            clearTimeout(timeout);
            resolve();
          }
        });
        
        ngrokProcess.stderr.on('data', (data) => {
          const error = data.toString();
          if (error.includes('error') || error.includes('failed')) {
            clearTimeout(timeout);
            ngrokProcess.kill();
            reject(new Error(error.trim()));
          }
        });
        
        ngrokProcess.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      
      if (tunnelUrl) {
        console.error('');
        console.error('🎉 OPENDIA READY!');
        console.error('📋 Copy this URL for online AI services:');
        console.error(`🔗 ${tunnelUrl}/sse`);
        console.error('');
        console.error('🔑 This URL is public — the tunnel requires a token:');
        console.error(`   Authorization: Bearer ${AUTH_TOKEN}`);
        console.error('   Reuse a fixed one across restarts with --token=<value>');
        console.error('');
        console.error('💡 ChatGPT: Settings → Connectors → Custom Connector');
        console.error('💡 Claude Web: Add as external MCP server (if supported)');
        console.error('');
        console.error('🏠 Local access still available:');
        console.error(`🔗 http://localhost:${HTTP_PORT}/sse`);
        console.error('');
        
        // Store ngrok process for cleanup
        global.ngrokProcess = ngrokProcess;
      } else {
        throw new Error('Could not extract tunnel URL');
      }
      
    } catch (error) {
      console.error('❌ Tunnel failed:', error.message);
      console.error('');
      console.error('💡 MANUAL NGROK OPTION:');
      console.error(`  1. Run: ngrok http ${HTTP_PORT}`);
      console.error('  2. Use the ngrok URL + /sse');
      console.error('');
      console.error('💡 Or use local URL:');
      console.error(`  🔗 http://localhost:${HTTP_PORT}/sse`);
      console.error('');
    }
  } else {
    console.error('');
    console.error('🏠 LOCAL MODE:');
    console.error(`🔗 SSE endpoint: http://localhost:${HTTP_PORT}/sse`);
    console.error('💡 For online AI access, restart with --tunnel flag');
    console.error('');
  }

  // Display transport info
  if (sseOnly) {
    console.error('📡 Transport: SSE-only (stdio disabled)');
    console.error(`💡 Configure Claude Desktop with: http://localhost:${HTTP_PORT}/sse`);
  } else {
    console.error('📡 Transport: Hybrid (stdio + SSE)');
    console.error('💡 Claude Desktop: Works with existing config');
    console.error('💡 Online AI: Use SSE endpoint above');
  }
  
  // Display port configuration help
  console.error('');
  console.error('🔧 Port Configuration:');
  console.error(`   Current: WebSocket=${WS_PORT}, HTTP=${HTTP_PORT}`);
  console.error('   Custom: npx opendia --ws-port=6000 --http-port=6001');
  console.error('   Or: npx opendia --port=6000 (uses 6000 and 6001)');
  console.error('   Note: Existing processes are automatically terminated');
  console.error('');
}

// Cleanup on exit
process.on('SIGINT', async () => {
  console.error('🔄 Shutting down...');
  if (enableTunnel && global.ngrokProcess) {
    console.error('🔄 Closing tunnel...');
    try {
      global.ngrokProcess.kill('SIGTERM');
    } catch (error) {
      // Ignore cleanup errors
    }
  }
  process.exit();
});


// Start the server. Without the catch, a throw in port resolution or tunnel
// setup surfaces as an unhandled rejection instead of a readable message.
startServer().catch((error) => {
  console.error('❌ Failed to start OpenDia:', error.message);
  process.exit(1);
});
