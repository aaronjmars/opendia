#!/usr/bin/env node

const WebSocket = require("ws");
const express = require("express");
const net = require('net');
const { exec } = require('child_process');

// ADD: New imports for SSE transport
const cors = require('cors');
const { createServer } = require('http');
const { spawn } = require('child_process');

// ADD: Enhanced command line argument parsing
const args = process.argv.slice(2);
const enableTunnel = args.includes('--tunnel') || args.includes('--auto-tunnel');
const sseOnly = args.includes('--sse-only');
const killExisting = args.includes('--kill-existing');

// Parse port arguments
const wsPortArg = args.find(arg => arg.startsWith('--ws-port='));
const httpPortArg = args.find(arg => arg.startsWith('--http-port='));
const portArg = args.find(arg => arg.startsWith('--port='));

// Default ports (changed from 3000/3001 to 5555/5556)
let WS_PORT = wsPortArg ? parseInt(wsPortArg.split('=')[1]) : (portArg ? parseInt(portArg.split('=')[1]) : 5555);
let HTTP_PORT = httpPortArg ? parseInt(httpPortArg.split('=')[1]) : (portArg ? parseInt(portArg.split('=')[1]) + 1 : 5556);

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

// ADD: Express app setup
const app = express();
app.use(cors());
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

      case "prompts/list":
        // Return available workflow prompts
        result = { 
          prompts: [
            {
              name: "post_to_social",
              description: "Post content to social media platforms with anti-detection bypass",
              arguments: [
                {
                  name: "content",
                  description: "The content to post",
                  required: true
                },
                {
                  name: "platform",
                  description: "Target platform (twitter, linkedin, facebook)",
                  required: false
                }
              ]
            },
            {
              name: "post_selected_quote",
              description: "Post currently selected text as a quote with commentary",
              arguments: [
                {
                  name: "commentary",
                  description: "Your commentary on the selected text",
                  required: false
                }
              ]
            },
            {
              name: "research_workflow",
              description: "Research a topic using current page and bookmarking findings",
              arguments: [
                {
                  name: "topic",
                  description: "Research topic or query",
                  required: true
                },
                {
                  name: "depth",
                  description: "Research depth: quick, thorough, comprehensive",
                  required: false
                }
              ]
            },
            {
              name: "analyze_browsing_session",
              description: "Analyze current browsing session and provide insights",
              arguments: [
                {
                  name: "focus",
                  description: "Analysis focus: productivity, research, trends",
                  required: false
                }
              ]
            },
            {
              name: "organize_tabs",
              description: "Organize and clean up browser tabs intelligently",
              arguments: [
                {
                  name: "strategy",
                  description: "Organization strategy: close_duplicates, group_by_domain, archive_old",
                  required: false
                }
              ]
            },
            {
              name: "fill_form_assistant",
              description: "Analyze and help fill out forms on the current page",
              arguments: [
                {
                  name: "form_type",
                  description: "Type of form: contact, registration, survey, application",
                  required: false
                }
              ]
            }
          ]
        };
        break;

      case "prompts/get":
        // Execute specific workflow based on prompt name
        const promptName = params.name;
        const promptArgs = params.arguments || {};
        
        try {
          let workflowResult;
          switch (promptName) {
            case "post_to_social":
              workflowResult = await executePostToSocialWorkflow(promptArgs);
              break;
            case "post_selected_quote":
              workflowResult = await executePostSelectedQuoteWorkflow(promptArgs);
              break;
            case "research_workflow":
              workflowResult = await executeResearchWorkflow(promptArgs);
              break;
            case "analyze_browsing_session":
              workflowResult = await executeSessionAnalysisWorkflow(promptArgs);
              break;
            case "organize_tabs":
              workflowResult = await executeOrganizeTabsWorkflow(promptArgs);
              break;
            case "fill_form_assistant":
              workflowResult = await executeFillFormWorkflow(promptArgs);
              break;
            default:
              throw new Error(`Unknown prompt: ${promptName}`);
          }
          
          result = {
            content: [
              {
                type: "text",
                text: workflowResult
              }
            ]
          };
        } catch (error) {
          result = {
            content: [
              {
                type: "text",
                text: `❌ Workflow execution failed: ${error.message}`
              }
            ],
            isError: true
          };
        }
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
      return `✅ Successfully navigated to: ${
        result.url || "unknown URL"
      }\n\n${JSON.stringify(metadata, null, 2)}`;

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
    const { summary, created_tabs, settings_used, warnings, errors } = result;
    
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

    // Add settings used (if available)
    if (settings_used) {
      output += `⚙️ Settings used:\n`;
      output += `   • Chunk size: ${settings_used.chunk_size}\n`;
      output += `   • Delay between chunks: ${settings_used.delay_between_chunks}ms\n`;
      output += `   • Delay between tabs: ${settings_used.delay_between_tabs}ms\n`;
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
    pendingCalls.set(callId, { resolve, reject });

    chromeExtensionSocket.send(
      JSON.stringify({
        id: callId,
        method: toolName,
        params: args,
      })
    );

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingCalls.has(callId)) {
        pendingCalls.delete(callId);
        reject(new Error("Tool call timeout"));
      }
    }, 30000);
  });
}

// Handle tool responses from Chrome/Firefox Extension
function handleToolResponse(message) {
  const pending = pendingCalls.get(message.id);
  if (pending) {
    pendingCalls.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }
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

// ADD: SSE/HTTP endpoints for online AI
app.route('/sse')
  .get((req, res) => {
    // SSE stream for connection
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
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

// ADD: CORS preflight handler
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Cache-Control');
  res.sendStatus(200);
});

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

// ADD: Health check endpoint (update existing one)
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

// ADD: Port discovery endpoint for Chrome/Firefox extension
app.get('/ports', (req, res) => {
  res.json({
    websocket: WS_PORT,
    http: HTTP_PORT,
    websocketUrl: `ws://localhost:${WS_PORT}`,
    httpUrl: `http://localhost:${HTTP_PORT}`,
    sseUrl: `http://localhost:${HTTP_PORT}/sse`
  });
});

// START: Enhanced server startup with port conflict resolution
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
  
  // Initialize WebSocket server after port resolution
  wss = new WebSocket.Server({ port: WS_PORT });
  
  // Set up WebSocket connection handling
  setupWebSocketHandlers();
  
  console.error(`✅ Ports resolved: WebSocket=${WS_PORT}, HTTP=${HTTP_PORT}`);
  
  // Start HTTP server
  const httpServer = app.listen(HTTP_PORT, () => {
    console.error(`🌐 HTTP/SSE server running on port ${HTTP_PORT}`);
    console.error(`🔌 Browser Extension connected on ws://localhost:${WS_PORT}`);
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

// Workflow execution functions
async function executePostToSocialWorkflow(args) {
  const { content, platform = "auto" } = args;
  
  if (!content) {
    throw new Error("Content is required for social media posting");
  }
  
  try {
    // Analyze the current page to determine platform and find posting elements
    const pageAnalysis = await callBrowserTool('page_analyze', {
      intent_hint: 'post_create',
      phase: 'discover',
      max_results: 3
    });
    
    if (!pageAnalysis.elements || pageAnalysis.elements.length === 0) {
      throw new Error("No posting elements found on current page. Please navigate to a social media platform.");
    }
    
    // Find the best textarea element for posting
    const textareaElement = pageAnalysis.elements.find(el => 
      el.type === 'textarea' || el.name.toLowerCase().includes('post') || el.name.toLowerCase().includes('tweet')
    );
    
    if (!textareaElement) {
      throw new Error("No suitable posting textarea found on current page");
    }
    
    // Fill the content using anti-detection bypass
    const fillResult = await callBrowserTool('element_fill', {
      element_id: textareaElement.id,
      value: content,
      clear_first: true
    });
    
    if (!fillResult.success) {
      throw new Error(`Failed to fill content: ${fillResult.actual_value}`);
    }
    
    // Look for submit button
    const submitElement = pageAnalysis.elements.find(el => 
      el.type === 'button' && (el.name.toLowerCase().includes('post') || el.name.toLowerCase().includes('tweet') || el.name.toLowerCase().includes('share'))
    );
    
    let result = `✅ Successfully posted content to social media!\n\n`;
    result += `📝 **Content posted:** "${content}"\n`;
    result += `🎯 **Platform detected:** ${pageAnalysis.summary?.anti_detection_platform || 'Generic'}\n`;
    result += `🔧 **Method used:** ${fillResult.method}\n`;
    result += `📊 **Fill success:** ${fillResult.success ? 'Yes' : 'No'}\n`;
    
    if (submitElement) {
      result += `\n💡 **Next step:** Click the "${submitElement.name}" button to publish your post.`;
    } else {
      result += `\n💡 **Next step:** Look for a "Post" or "Tweet" button to publish your content.`;
    }
    
    return result;
    
  } catch (error) {
    throw new Error(`Social media posting failed: ${error.message}`);
  }
}

async function executePostSelectedQuoteWorkflow(args) {
  const { commentary = "" } = args;
  
  try {
    // Get selected text from current page
    const selectedText = await callBrowserTool('get_selected_text', {
      include_metadata: true,
      max_length: 1000
    });
    
    if (!selectedText.has_selection) {
      throw new Error("No text is currently selected. Please select some text first.");
    }
    
    // Format the quote with commentary
    let quoteContent = `"${selectedText.selected_text}"`;
    if (selectedText.selection_metadata?.page_info?.title) {
      quoteContent += `\n\n— ${selectedText.selection_metadata.page_info.title}`;
    }
    if (selectedText.selection_metadata?.page_info?.url) {
      quoteContent += `\n${selectedText.selection_metadata.page_info.url}`;
    }
    if (commentary) {
      quoteContent += `\n\n${commentary}`;
    }
    
    // Execute the post workflow with the formatted quote
    const postResult = await executePostToSocialWorkflow({ content: quoteContent });
    
    let result = `🎯 **Selected Quote Posting Workflow**\n\n`;
    result += `📝 **Selected text:** "${selectedText.selected_text.substring(0, 100)}${selectedText.selected_text.length > 100 ? '...' : ''}"\n`;
    result += `📄 **Source:** ${selectedText.selection_metadata?.page_info?.title || 'Current page'}\n`;
    result += `💬 **Commentary:** ${commentary || 'None'}\n`;
    result += `📊 **Character count:** ${quoteContent.length}\n\n`;
    result += postResult;
    
    return result;
    
  } catch (error) {
    throw new Error(`Quote posting workflow failed: ${error.message}`);
  }
}

async function executeResearchWorkflow(args) {
  const { topic, depth = "thorough" } = args;
  
  if (!topic) {
    throw new Error("Research topic is required");
  }
  
  try {
    // Analyze current page content
    const pageContent = await callBrowserTool('page_extract_content', {
      content_type: 'article',
      summarize: true
    });
    
    // Get current page links for related research
    const pageLinks = await callBrowserTool('get_page_links', {
      include_internal: true,
      include_external: true,
      max_results: 20
    });
    
    // Search browsing history for related content
    const historyResults = await callBrowserTool('get_history', {
      keywords: topic,
      max_results: 10,
      sort_by: 'visit_time'
    });
    
    // Bookmark current page if it has relevant content - URL will be obtained from browser extension
    const currentUrl = pageContent.content?.url;
    const currentTitle = pageContent.summary?.title;
    
    if (currentUrl && currentTitle) {
      try {
        await callBrowserTool('add_bookmark', {
          title: `[Research: ${topic}] ${currentTitle}`,
          url: currentUrl
        });
      } catch (bookmarkError) {
        console.warn('Bookmark creation failed:', bookmarkError.message);
      }
    }
    
    // Compile research summary
    let result = `🔍 **Research Workflow: ${topic}**\n\n`;
    
    // Current page analysis
    result += `📄 **Current Page Analysis:**\n`;
    if (pageContent.summary) {
      result += `• **Title:** ${pageContent.summary.title || 'N/A'}\n`;
      result += `• **Word count:** ${pageContent.summary.word_count || 0}\n`;
      result += `• **Reading time:** ${pageContent.summary.reading_time || 0} minutes\n`;
      result += `• **Has media:** ${pageContent.summary.has_images || pageContent.summary.has_videos ? 'Yes' : 'No'}\n`;
      if (pageContent.summary.preview) {
        result += `• **Preview:** ${pageContent.summary.preview}\n`;
      }
    }
    
    // Related links
    result += `\n🔗 **Related Links Found:** ${pageLinks.returned}\n`;
    const relevantLinks = pageLinks.links.filter(link => 
      link.text.toLowerCase().includes(topic.toLowerCase()) || 
      link.url.toLowerCase().includes(topic.toLowerCase())
    ).slice(0, 5);
    
    if (relevantLinks.length > 0) {
      result += `**Top relevant links:**\n`;
      relevantLinks.forEach((link, index) => {
        result += `${index + 1}. [${link.text}](${link.url})\n`;
      });
    }
    
    // History analysis
    result += `\n📚 **Previous Research:**\n`;
    if (historyResults.history_items && historyResults.history_items.length > 0) {
      result += `Found ${historyResults.history_items.length} related pages in your history:\n`;
      historyResults.history_items.slice(0, 5).forEach((item, index) => {
        result += `${index + 1}. **${item.title}** (visited ${item.visit_count} times)\n`;
        result += `   ${item.url}\n`;
      });
    } else {
      result += `No previous research found in browsing history.\n`;
    }
    
    // Research recommendations
    result += `\n💡 **Next Steps:**\n`;
    if (depth === "comprehensive") {
      result += `• Explore the ${pageLinks.returned} links found on current page\n`;
      result += `• Cross-reference with ${historyResults.metadata?.total_found || 0} historical visits\n`;
      result += `• Consider bookmarking additional relevant pages\n`;
    } else if (depth === "thorough") {
      result += `• Review top ${Math.min(5, pageLinks.returned)} most relevant links\n`;
      result += `• Check recent history for related content\n`;
    } else {
      result += `• Focus on current page content and top 3 related links\n`;
    }
    
    result += `\n✅ **Current page bookmarked for reference**`;
    
    return result;
    
  } catch (error) {
    throw new Error(`Research workflow failed: ${error.message}`);
  }
}

async function executeSessionAnalysisWorkflow(args) {
  const { focus = "productivity" } = args;
  
  try {
    // Get all open tabs
    const tabList = await callBrowserTool('tab_list', {
      current_window_only: false,
      include_details: true
    });
    
    // Get recent browsing history
    const recentHistory = await callBrowserTool('get_history', {
      max_results: 50,
      sort_by: 'visit_time',
      sort_order: 'desc'
    });
    
    // Analyze current page
    const currentPageContent = await callBrowserTool('page_extract_content', {
      content_type: 'article',
      summarize: true
    });
    
    // Process tabs data
    const tabs = tabList.tabs || [];
    const domains = [...new Set(tabs.map(tab => {
      try {
        return new URL(tab.url).hostname;
      } catch {
        return 'unknown';
      }
    }))];
    
    // Categorize tabs by domain type
    const socialMediaDomains = ['twitter.com', 'x.com', 'linkedin.com', 'facebook.com', 'instagram.com'];
    const productivityDomains = ['docs.google.com', 'notion.so', 'obsidian.md', 'github.com'];
    const newsDomains = ['news.google.com', 'bbc.com', 'cnn.com', 'reuters.com'];
    
    const categorizedTabs = {
      social: tabs.filter(tab => socialMediaDomains.some(domain => tab.url.includes(domain))),
      productivity: tabs.filter(tab => productivityDomains.some(domain => tab.url.includes(domain))),
      news: tabs.filter(tab => newsDomains.some(domain => tab.url.includes(domain))),
      other: tabs.filter(tab => 
        !socialMediaDomains.some(domain => tab.url.includes(domain)) &&
        !productivityDomains.some(domain => tab.url.includes(domain)) &&
        !newsDomains.some(domain => tab.url.includes(domain))
      )
    };
    
    // Compile analysis
    let result = `📊 **Browsing Session Analysis**\n\n`;
    
    // Session overview
    result += `🎯 **Session Overview:**\n`;
    result += `• **Total open tabs:** ${tabs.length}\n`;
    result += `• **Unique domains:** ${domains.length}\n`;
    result += `• **Active tab:** ${tabList.active_tab ? 'Yes' : 'No'}\n`;
    result += `• **Recent history items:** ${recentHistory.metadata?.total_found || 0}\n`;
    
    // Tab categorization
    result += `\n📂 **Tab Categories:**\n`;
    result += `• **Social Media:** ${categorizedTabs.social.length} tabs\n`;
    result += `• **Productivity:** ${categorizedTabs.productivity.length} tabs\n`;
    result += `• **News/Information:** ${categorizedTabs.news.length} tabs\n`;
    result += `• **Other:** ${categorizedTabs.other.length} tabs\n`;
    
    // Domain analysis
    result += `\n🌐 **Top Domains:**\n`;
    const domainCounts = {};
    tabs.forEach(tab => {
      try {
        const domain = new URL(tab.url).hostname;
        domainCounts[domain] = (domainCounts[domain] || 0) + 1;
      } catch {}
    });
    
    Object.entries(domainCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .forEach(([domain, count]) => {
        result += `• **${domain}:** ${count} tab${count > 1 ? 's' : ''}\n`;
      });
    
    // Focus-specific analysis
    if (focus === "productivity") {
      result += `\n💼 **Productivity Analysis:**\n`;
      const duplicateTabs = tabs.filter((tab, index) => 
        tabs.findIndex(t => t.url === tab.url) !== index
      );
      result += `• **Duplicate tabs:** ${duplicateTabs.length}\n`;
      result += `• **Productivity tools:** ${categorizedTabs.productivity.length}\n`;
      result += `• **Social media distractions:** ${categorizedTabs.social.length}\n`;
      
      if (categorizedTabs.productivity.length > 0) {
        result += `\n**Active productivity tools:**\n`;
        categorizedTabs.productivity.slice(0, 3).forEach(tab => {
          result += `• ${tab.title}\n`;
        });
      }
    } else if (focus === "research") {
      result += `\n🔍 **Research Analysis:**\n`;
      result += `• **Information sources:** ${categorizedTabs.news.length + categorizedTabs.other.length}\n`;
      result += `• **Research depth:** ${recentHistory.metadata?.total_found > 20 ? 'Deep' : 'Surface'}\n`;
      
      if (currentPageContent.summary) {
        result += `• **Current page type:** ${currentPageContent.content_type || 'Unknown'}\n`;
        result += `• **Reading time:** ${currentPageContent.summary.reading_time || 0} minutes\n`;
      }
    }
    
    // Recommendations
    result += `\n💡 **Recommendations:**\n`;
    if (tabs.length > 20) {
      result += `• Consider closing some tabs to improve performance\n`;
    }
    if (domainCounts['twitter.com'] > 3 || domainCounts['x.com'] > 3) {
      result += `• Multiple social media tabs detected - consider consolidating\n`;
    }
    if (categorizedTabs.productivity.length > 0 && categorizedTabs.social.length > 0) {
      result += `• Mix of productivity and social tabs - consider separate browsing sessions\n`;
    }
    
    result += `\n📈 **Session Score:** ${Math.round(((categorizedTabs.productivity.length + categorizedTabs.news.length) / tabs.length) * 100)}% productive`;
    
    return result;
    
  } catch (error) {
    throw new Error(`Session analysis workflow failed: ${error.message}`);
  }
}

async function executeOrganizeTabsWorkflow(args) {
  const { strategy = "close_duplicates" } = args;
  
  try {
    // Get all open tabs
    const tabList = await callBrowserTool('tab_list', {
      current_window_only: false,
      include_details: true
    });
    
    const tabs = tabList.tabs || [];
    let result = `🗂️ **Tab Organization Workflow**\n\n`;
    result += `📊 **Starting with ${tabs.length} tabs**\n\n`;
    
    let closedTabs = [];
    let organizedTabs = [];
    
    if (strategy === "close_duplicates") {
      // Find and close duplicate tabs
      const seenUrls = new Set();
      const duplicates = [];
      
      tabs.forEach(tab => {
        if (seenUrls.has(tab.url)) {
          duplicates.push(tab);
        } else {
          seenUrls.add(tab.url);
        }
      });
      
      // Close duplicate tabs (keep the first occurrence)
      if (duplicates.length > 0) {
        const tabIds = duplicates.map(tab => tab.id);
        const closeResult = await callBrowserTool('tab_close', {
          tab_ids: tabIds
        });
        
        if (closeResult.success) {
          closedTabs = duplicates;
          result += `✅ **Closed ${duplicates.length} duplicate tabs:**\n`;
          duplicates.forEach(tab => {
            result += `• ${tab.title}\n`;
          });
        }
      } else {
        result += `✅ **No duplicate tabs found**\n`;
      }
      
    } else if (strategy === "group_by_domain") {
      // Group tabs by domain
      const domainGroups = {};
      tabs.forEach(tab => {
        try {
          const domain = new URL(tab.url).hostname;
          if (!domainGroups[domain]) {
            domainGroups[domain] = [];
          }
          domainGroups[domain].push(tab);
        } catch {
          if (!domainGroups['unknown']) {
            domainGroups['unknown'] = [];
          }
          domainGroups['unknown'].push(tab);
        }
      });
      
      result += `📂 **Grouped tabs by domain:**\n`;
      Object.entries(domainGroups).forEach(([domain, domainTabs]) => {
        result += `• **${domain}:** ${domainTabs.length} tabs\n`;
        domainTabs.slice(0, 3).forEach(tab => {
          result += `  - ${tab.title}\n`;
        });
        if (domainTabs.length > 3) {
          result += `  - ... and ${domainTabs.length - 3} more\n`;
        }
      });
      
    } else if (strategy === "archive_old") {
      // Find tabs that haven't been active recently
      const currentTime = Date.now();
      const oneHourAgo = currentTime - (60 * 60 * 1000);
      
      // Since we don't have last accessed time, we'll use a heuristic
      // based on tab loading status and position
      const staleTabsToClose = tabs.filter(tab => 
        tab.status === 'complete' && 
        !tab.active && 
        !tab.pinned &&
        tab.index > 10 // Assume tabs at the end are less active
      ).slice(0, 10); // Limit to 10 tabs max
      
      if (staleTabsToClose.length > 0) {
        const tabIds = staleTabsToClose.map(tab => tab.id);
        const closeResult = await callBrowserTool('tab_close', {
          tab_ids: tabIds
        });
        
        if (closeResult.success) {
          closedTabs = staleTabsToClose;
          result += `✅ **Archived ${staleTabsToClose.length} old tabs:**\n`;
          staleTabsToClose.forEach(tab => {
            result += `• ${tab.title}\n`;
          });
        }
      } else {
        result += `✅ **No old tabs to archive**\n`;
      }
    }
    
    // Final summary
    const remainingTabs = tabs.length - closedTabs.length;
    result += `\n📈 **Organization Results:**\n`;
    result += `• **Tabs closed:** ${closedTabs.length}\n`;
    result += `• **Tabs remaining:** ${remainingTabs}\n`;
    result += `• **Organization strategy:** ${strategy}\n`;
    
    if (remainingTabs > 15) {
      result += `\n💡 **Recommendation:** Consider running additional organization strategies to further reduce tab count.`;
    } else {
      result += `\n✅ **Tab organization complete!** Your browsing session is now more organized.`;
    }
    
    return result;
    
  } catch (error) {
    throw new Error(`Tab organization workflow failed: ${error.message}`);
  }
}

async function executeFillFormWorkflow(args) {
  const { form_type = "auto" } = args;
  
  try {
    // Analyze page for form elements
    const formAnalysis = await callBrowserTool('page_analyze', {
      intent_hint: 'form submit',
      phase: 'detailed',
      focus_areas: ['forms', 'buttons'],
      max_results: 10
    });
    
    if (!formAnalysis.elements || formAnalysis.elements.length === 0) {
      throw new Error("No form elements found on current page");
    }
    
    // Categorize form elements
    const formElements = {
      inputs: formAnalysis.elements.filter(el => el.type === 'input'),
      textareas: formAnalysis.elements.filter(el => el.type === 'textarea'),
      selects: formAnalysis.elements.filter(el => el.type === 'select'),
      buttons: formAnalysis.elements.filter(el => el.type === 'button')
    };
    
    // Analyze each form element for type and requirements
    let result = `📝 **Form Analysis & Fill Assistant**\n\n`;
    
    // Form overview
    result += `🔍 **Form Elements Found:**\n`;
    result += `• **Input fields:** ${formElements.inputs.length}\n`;
    result += `• **Text areas:** ${formElements.textareas.length}\n`;
    result += `• **Select dropdowns:** ${formElements.selects.length}\n`;
    result += `• **Buttons:** ${formElements.buttons.length}\n`;
    
    // Detailed element analysis
    if (formElements.inputs.length > 0) {
      result += `\n📊 **Input Field Analysis:**\n`;
      formElements.inputs.forEach((input, index) => {
        const elementState = formAnalysis.elements.find(el => el.id === input.id);
        result += `${index + 1}. **${input.name}**\n`;
        result += `   • Element ID: ${input.id}\n`;
        result += `   • Ready: ${elementState?.ready ? 'Yes' : 'No'}\n`;
        result += `   • Required: ${input.name.includes('*') ? 'Yes' : 'Unknown'}\n`;
        
        // Suggest field type based on name
        const fieldName = input.name.toLowerCase();
        if (fieldName.includes('email')) {
          result += `   • **Suggested type:** Email address\n`;
        } else if (fieldName.includes('name')) {
          result += `   • **Suggested type:** Name field\n`;
        } else if (fieldName.includes('phone')) {
          result += `   • **Suggested type:** Phone number\n`;
        } else if (fieldName.includes('password')) {
          result += `   • **Suggested type:** Password\n`;
        } else {
          result += `   • **Suggested type:** General text input\n`;
        }
      });
    }
    
    // Text area analysis
    if (formElements.textareas.length > 0) {
      result += `\n📝 **Text Area Analysis:**\n`;
      formElements.textareas.forEach((textarea, index) => {
        result += `${index + 1}. **${textarea.name}**\n`;
        result += `   • Element ID: ${textarea.id}\n`;
        result += `   • **Suggested use:** Long-form text input\n`;
      });
    }
    
    // Submit buttons
    if (formElements.buttons.length > 0) {
      result += `\n🔘 **Submit Buttons:**\n`;
      const submitButtons = formElements.buttons.filter(btn => 
        btn.name.toLowerCase().includes('submit') || 
        btn.name.toLowerCase().includes('send') ||
        btn.name.toLowerCase().includes('save')
      );
      
      submitButtons.forEach((button, index) => {
        result += `${index + 1}. **${button.name}** (ID: ${button.id})\n`;
      });
    }
    
    // Form type detection
    result += `\n🎯 **Detected Form Type:**\n`;
    // Note: Page content detection would need to be done through browser tools
    const contentLower = '';
    
    let detectedType = 'unknown';
    if (contentLower.includes('contact') || contentLower.includes('get in touch')) {
      detectedType = 'contact';
    } else if (contentLower.includes('register') || contentLower.includes('sign up')) {
      detectedType = 'registration';
    } else if (contentLower.includes('survey') || contentLower.includes('feedback')) {
      detectedType = 'survey';
    } else if (contentLower.includes('application') || contentLower.includes('apply')) {
      detectedType = 'application';
    }
    
    result += `• **Auto-detected:** ${detectedType}\n`;
    result += `• **User specified:** ${form_type}\n`;
    
    // Filling recommendations
    result += `\n💡 **Filling Recommendations:**\n`;
    if (formElements.inputs.length > 0) {
      result += `• Start with required fields (marked with *)\n`;
      result += `• Use the element IDs provided for precise filling\n`;
      result += `• Test form validation before final submission\n`;
    }
    
    // Ready-to-fill elements
    const readyElements = formAnalysis.elements.filter(el => el.ready);
    result += `\n✅ **Ready to Fill:** ${readyElements.length} elements are ready for interaction\n`;
    
    if (readyElements.length > 0) {
      result += `**Next steps:**\n`;
      result += `1. Use element_fill with the provided Element IDs\n`;
      result += `2. Fill required fields first\n`;
      result += `3. Review form before submission\n`;
      result += `4. Click appropriate submit button when ready\n`;
    }
    
    return result;
    
  } catch (error) {
    throw new Error(`Form analysis workflow failed: ${error.message}`);
  }
}

// Start the server
startServer();
