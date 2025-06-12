#!/usr/bin/env node

const WebSocket = require("ws");
const express = require("express");

// WebSocket server for Chrome Extension
const wss = new WebSocket.Server({ 
  port: 3000,
  perMessageDeflate: false // Disable compression for better performance
});

let chromeExtensionSocket = null;
let availableTools = [];
let connectionStatus = {
  connected: false,
  lastConnection: null,
  reconnectAttempts: 0,
  maxReconnectAttempts: 5
};

// Tool call tracking with improved timeout handling
const pendingCalls = new Map();
const TOOL_CALL_TIMEOUT = 60000; // Increase timeout to 60 seconds
const PING_INTERVAL = 15000; // Ping every 15 seconds

// Simple MCP protocol implementation over stdio
async function handleMCPRequest(request) {
  const { method, params, id } = request;

  // Handle notifications (no id means it's a notification)
  if (!id && method.startsWith("notifications/")) {
    console.error(`Received notification: ${method}`);
    return null; // No response needed for notifications
  }

  // Handle requests that don't need implementation
  if (!id) {
    return null; // No response for notifications
  }

  try {
    let result;

    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "browser-mcp-server",
            version: "1.0.0",
          },
        };
        break;

      case "tools/list":
        result = {
          tools: availableTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        };
        break;

      case "tools/call":
        const toolResult = await callBrowserTool(
          params.name,
          params.arguments || {}
        );
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify(toolResult, null, 2),
            },
          ],
        };
        break;

      case "resources/list":
        // Return empty resources list
        result = { resources: [] };
        break;

      case "prompts/list":
        // Return empty prompts list
        result = { prompts: [] };
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

// Call browser tool through Chrome Extension
async function callBrowserTool(toolName, args) {
  if (
    !chromeExtensionSocket ||
    chromeExtensionSocket.readyState !== WebSocket.OPEN
  ) {
    throw new Error(
      "Chrome Extension not connected. Make sure the extension is installed and active."
    );
  }

  const callId = Date.now().toString() + Math.random().toString(36).substr(2, 9);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    pendingCalls.set(callId, { 
      resolve, 
      reject, 
      startTime,
      toolName,
      args
    });

    try {
      chromeExtensionSocket.send(
        JSON.stringify({
          id: callId,
          method: toolName,
          params: args,
        })
      );
    } catch (error) {
      pendingCalls.delete(callId);
      reject(new Error(`Failed to send tool call: ${error.message}`));
      return;
    }

    // Timeout with better error message
    const timeoutId = setTimeout(() => {
      if (pendingCalls.has(callId)) {
        pendingCalls.delete(callId);
        const duration = Date.now() - startTime;
        reject(new Error(`Tool call '${toolName}' timed out after ${duration}ms (limit: ${TOOL_CALL_TIMEOUT}ms)`));
      }
    }, TOOL_CALL_TIMEOUT);

    // Store timeout ID for cleanup
    pendingCalls.get(callId).timeoutId = timeoutId;
  });
}

// Handle tool responses from Chrome Extension
function handleToolResponse(message) {
  const pending = pendingCalls.get(message.id);
  if (pending) {
    // Clear timeout
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    
    pendingCalls.delete(message.id);
    
    if (message.error) {
      pending.reject(new Error(message.error.message || 'Unknown tool error'));
    } else {
      pending.resolve(message.result);
    }
  } else {
    console.error(`Received response for unknown call ID: ${message.id}`);
  }
}

// Handle Chrome Extension connections
wss.on("connection", (ws) => {
  console.error("Chrome Extension connected");
  chromeExtensionSocket = ws;
  
  // Update connection status
  connectionStatus.connected = true;
  connectionStatus.lastConnection = new Date();
  connectionStatus.reconnectAttempts = 0;

  let pingInterval;
  let isAlive = true;

  // Set up ping/pong for keepalive with heartbeat detection
  const setupPingPong = () => {
    pingInterval = setInterval(() => {
      if (!isAlive) {
        console.error("Chrome Extension failed heartbeat check, terminating connection");
        ws.terminate();
        return;
      }
      
      isAlive = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, PING_INTERVAL);
  };

  setupPingPong();

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === "register") {
        availableTools = message.tools;
        console.error(`Registered ${availableTools.length} browser tools`);
      } else if (message.type === "ping") {
        // Respond to ping with pong
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        }
      } else if (message.type === "pong") {
        // Handle pong response
        isAlive = true;
      } else if (message.id) {
        // Handle tool response
        handleToolResponse(message);
      }
    } catch (error) {
      console.error("Error processing message:", error);
      console.error("Raw message data:", data.toString());
    }
  });

  ws.on("close", (code, reason) => {
    console.error(`Chrome Extension disconnected (code: ${code}, reason: ${reason || 'none'})`);
    chromeExtensionSocket = null;
    connectionStatus.connected = false;
    
    if (pingInterval) {
      clearInterval(pingInterval);
    }
    
    // Clean up any pending calls
    for (const [callId, pending] of pendingCalls.entries()) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(new Error('WebSocket connection closed'));
    }
    pendingCalls.clear();
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
    connectionStatus.connected = false;
  });

  ws.on("pong", () => {
    // Extension responded to ping - it's alive
    isAlive = true;
  });
});

// Read from stdin with improved error handling
let inputBuffer = "";
process.stdin.on("data", async (chunk) => {
  try {
    inputBuffer += chunk.toString();

    // Process complete lines
    const lines = inputBuffer.split("\n");
    inputBuffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        try {
          const request = JSON.parse(line);
          console.error(`Processing MCP request: ${request.method} (id: ${request.id || 'notification'})`);
          
          const response = await handleMCPRequest(request);

          // Only send response if one was generated (not for notifications)
          if (response) {
            process.stdout.write(JSON.stringify(response) + "\n");
            console.error(`Sent MCP response for: ${request.method}`);
          }
        } catch (error) {
          console.error("Error processing MCP request:", error);
          console.error("Request line:", line);
          
          // Send error response if we have an ID
          try {
            const request = JSON.parse(line);
            if (request.id) {
              const errorResponse = {
                jsonrpc: "2.0",
                id: request.id,
                error: {
                  code: -32603,
                  message: error.message
                }
              };
              process.stdout.write(JSON.stringify(errorResponse) + "\n");
            }
          } catch (parseError) {
            console.error("Could not parse request for error response:", parseError);
          }
        }
      }
    }
  } catch (error) {
    console.error("Error processing stdin data:", error);
  }
});

// Handle stdin errors
process.stdin.on("error", (error) => {
  console.error("Error reading from stdin:", error);
});

// Handle process cleanup
process.on("SIGINT", () => {
  console.error("Received SIGINT, shutting down gracefully...");
  
  // Clean up pending calls
  for (const [callId, pending] of pendingCalls.entries()) {
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    pending.reject(new Error('Server shutting down'));
  }
  pendingCalls.clear();
  
  // Close WebSocket server
  wss.close(() => {
    console.error("WebSocket server closed");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  console.error("Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

// Optional: HTTP endpoint for health checks
const app = express();
app.get("/health", (req, res) => {
  const now = new Date();
  res.json({
    status: connectionStatus.connected ? "connected" : "disconnected",
    chromeExtensionConnected: chromeExtensionSocket !== null && chromeExtensionSocket.readyState === WebSocket.OPEN,
    availableTools: availableTools.length,
    connectionStatus: {
      ...connectionStatus,
      uptime: connectionStatus.lastConnection ? now - connectionStatus.lastConnection : null
    },
    pendingCalls: pendingCalls.size,
    serverStartTime: process.uptime(),
    timestamp: now.toISOString()
  });
});

// Add endpoint to get detailed tool list
app.get("/tools", (req, res) => {
  res.json({
    tools: availableTools,
    count: availableTools.length,
    connected: chromeExtensionSocket !== null && chromeExtensionSocket.readyState === WebSocket.OPEN
  });
});

app.listen(3001, () => {
  console.error(
    "Health check endpoint available at http://localhost:3001/health"
  );
  console.error(
    "Tools endpoint available at http://localhost:3001/tools"
  );
});

// WebSocket server error handling
wss.on("error", (error) => {
  console.error("WebSocket server error:", error);
});

console.error("Browser MCP Server started");
console.error("Waiting for Chrome Extension connection on ws://localhost:3000");
console.error(`Tool call timeout: ${TOOL_CALL_TIMEOUT}ms`);
console.error(`Ping interval: ${PING_INTERVAL}ms`);
console.error(`Process ID: ${process.pid}`);
