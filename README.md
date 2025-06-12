# Chrome Extension MCP Bridge

This project creates a Chrome Extension that exposes browser functions through the Model Context Protocol (MCP), allowing AI models to interact with browser capabilities.

## Project Structure

```
chrome-mcp-extension/
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   └── popup.js
├── mcp-server/
│   ├── package.json
│   ├── server.js
│   └── .env
└── README.md
```

## Chrome Extension

### manifest.json
```json
{
  "manifest_version": 3,
  "name": "Browser MCP Bridge",
  "version": "1.0.0",
  "description": "Exposes browser functions through Model Context Protocol",
  "permissions": [
    "tabs",
    "activeTab",
    "storage",
    "bookmarks",
    "history",
    "downloads",
    "cookies",
    "webNavigation",
    "scripting",
    "nativeMessaging",
    "contextMenus",
    "notifications",
    "alarms",
    "clipboardRead",
    "clipboardWrite"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html",
    "default_title": "MCP Browser Bridge"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "externally_connectable": {
    "ids": ["*"],
    "matches": ["http://localhost/*"]
  }
}
```

### background.js
```javascript
// MCP Server connection configuration
const MCP_SERVER_URL = 'ws://localhost:3000';
let mcpSocket = null;
let reconnectInterval = null;

// Initialize WebSocket connection to MCP server
function connectToMCPServer() {
  if (mcpSocket && mcpSocket.readyState === WebSocket.OPEN) return;
  
  mcpSocket = new WebSocket(MCP_SERVER_URL);
  
  mcpSocket.onopen = () => {
    console.log('Connected to MCP server');
    clearInterval(reconnectInterval);
    
    // Register available browser functions
    mcpSocket.send(JSON.stringify({
      type: 'register',
      tools: getAvailableTools()
    }));
  };
  
  mcpSocket.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    await handleMCPRequest(message);
  };
  
  mcpSocket.onclose = () => {
    console.log('Disconnected from MCP server');
    // Attempt to reconnect every 5 seconds
    reconnectInterval = setInterval(connectToMCPServer, 5000);
  };
  
  mcpSocket.onerror = (error) => {
    console.error('MCP connection error:', error);
  };
}

// Define available browser tools for MCP
function getAvailableTools() {
  return [
    {
      name: 'browser_navigate',
      description: 'Navigate to a URL in the active tab',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' }
        },
        required: ['url']
      }
    },
    {
      name: 'browser_get_tabs',
      description: 'Get all open tabs',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'browser_create_tab',
      description: 'Create a new tab',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL for the new tab' },
          active: { type: 'boolean', description: 'Whether to make the tab active' }
        }
      }
    },
    {
      name: 'browser_close_tab',
      description: 'Close a tab by ID',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'ID of the tab to close' }
        },
        required: ['tabId']
      }
    },
    {
      name: 'browser_execute_script',
      description: 'Execute JavaScript in the active tab',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to execute' }
        },
        required: ['code']
      }
    },
    {
      name: 'browser_get_page_content',
      description: 'Get the content of the active page',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to get specific content' }
        }
      }
    },
    {
      name: 'browser_take_screenshot',
      description: 'Take a screenshot of the active tab',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format' }
        }
      }
    },
    {
      name: 'browser_get_bookmarks',
      description: 'Get browser bookmarks',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query for bookmarks' }
        }
      }
    },
    {
      name: 'browser_add_bookmark',
      description: 'Add a bookmark',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Bookmark title' },
          url: { type: 'string', description: 'Bookmark URL' }
        },
        required: ['title', 'url']
      }
    },
    {
      name: 'browser_get_history',
      description: 'Search browser history',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: { type: 'number', description: 'Maximum number of results' }
        }
      }
    },
    {
      name: 'browser_get_cookies',
      description: 'Get cookies for a domain',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Domain to get cookies for' }
        }
      }
    },
    {
      name: 'browser_fill_form',
      description: 'Fill a form on the current page',
      inputSchema: {
        type: 'object',
        properties: {
          formData: { 
            type: 'object', 
            description: 'Key-value pairs of form field names/IDs and values' 
          }
        },
        required: ['formData']
      }
    },
    {
      name: 'browser_click_element',
      description: 'Click an element on the page',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of element to click' }
        },
        required: ['selector']
      }
    }
  ];
}

// Handle MCP requests
async function handleMCPRequest(message) {
  const { id, method, params } = message;
  
  try {
    let result;
    
    switch (method) {
      case 'browser_navigate':
        result = await navigateToUrl(params.url);
        break;
      case 'browser_get_tabs':
        result = await getTabs();
        break;
      case 'browser_create_tab':
        result = await createTab(params);
        break;
      case 'browser_close_tab':
        result = await closeTab(params.tabId);
        break;
      case 'browser_execute_script':
        result = await executeScript(params.code);
        break;
      case 'browser_get_page_content':
        result = await getPageContent(params.selector);
        break;
      case 'browser_take_screenshot':
        result = await takeScreenshot(params.format);
        break;
      case 'browser_get_bookmarks':
        result = await getBookmarks(params.query);
        break;
      case 'browser_add_bookmark':
        result = await addBookmark(params);
        break;
      case 'browser_get_history':
        result = await getHistory(params);
        break;
      case 'browser_get_cookies':
        result = await getCookies(params.domain);
        break;
      case 'browser_fill_form':
        result = await fillForm(params.formData);
        break;
      case 'browser_click_element':
        result = await clickElement(params.selector);
        break;
      default:
        throw new Error(`Unknown method: ${method}`);
    }
    
    // Send success response
    mcpSocket.send(JSON.stringify({
      id,
      result
    }));
  } catch (error) {
    // Send error response
    mcpSocket.send(JSON.stringify({
      id,
      error: {
        message: error.message,
        code: -32603
      }
    }));
  }
}

// Browser function implementations
async function navigateToUrl(url) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.update(activeTab.id, { url });
  return { success: true, tabId: activeTab.id };
}

async function getTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(tab => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    windowId: tab.windowId
  }));
}

async function createTab(params) {
  const tab = await chrome.tabs.create({
    url: params.url || 'about:blank',
    active: params.active !== false
  });
  return { id: tab.id, windowId: tab.windowId };
}

async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  return { success: true };
}

async function executeScript(code) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const results = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: new Function(code),
  });
  return results[0].result;
}

async function getPageContent(selector) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const results = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: (sel) => {
      if (sel) {
        const element = document.querySelector(sel);
        return element ? element.innerText : null;
      }
      return document.body.innerText;
    },
    args: [selector]
  });
  return results[0].result;
}

async function takeScreenshot(format = 'png') {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format });
  return { dataUrl, format };
}

async function getBookmarks(query) {
  if (query) {
    return await chrome.bookmarks.search(query);
  }
  return await chrome.bookmarks.getTree();
}

async function addBookmark(params) {
  const bookmark = await chrome.bookmarks.create({
    title: params.title,
    url: params.url
  });
  return bookmark;
}

async function getHistory(params) {
  const historyItems = await chrome.history.search({
    text: params.query || '',
    maxResults: params.maxResults || 100
  });
  return historyItems;
}

async function getCookies(domain) {
  const cookies = await chrome.cookies.getAll({ domain });
  return cookies;
}

async function fillForm(formData) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const results = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: (data) => {
      for (const [key, value] of Object.entries(data)) {
        const element = document.querySelector(`[name="${key}"], #${key}`);
        if (element) {
          element.value = value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return { success: true, filled: Object.keys(data).length };
    },
    args: [formData]
  });
  return results[0].result;
}

async function clickElement(selector) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const results = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: (sel) => {
      const element = document.querySelector(sel);
      if (element) {
        element.click();
        return { success: true, clicked: sel };
      }
      throw new Error(`Element not found: ${sel}`);
    },
    args: [selector]
  });
  return results[0].result;
}

// Initialize connection when extension loads
connectToMCPServer();

// Handle extension icon click
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
```

### content.js
```javascript
// Content script for interacting with web pages
console.log('MCP Browser Bridge content script loaded');

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getPageInfo') {
    sendResponse({
      title: document.title,
      url: window.location.href,
      content: document.body.innerText
    });
  }
});
```

### popup.html
```html
<!DOCTYPE html>
<html>
<head>
  <title>MCP Browser Bridge</title>
  <style>
    body {
      width: 350px;
      padding: 16px;
      font-family: Arial, sans-serif;
    }
    .status {
      display: flex;
      align-items: center;
      margin-bottom: 16px;
    }
    .status-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      margin-right: 8px;
    }
    .connected { background-color: #4CAF50; }
    .disconnected { background-color: #f44336; }
    .info {
      background-color: #f5f5f5;
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 12px;
    }
    button {
      background-color: #2196F3;
      color: white;
      border: none;
      padding: 10px 16px;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 8px;
    }
    button:hover {
      background-color: #1976D2;
    }
    .log {
      background-color: #f9f9f9;
      border: 1px solid #ddd;
      padding: 8px;
      margin-top: 12px;
      max-height: 200px;
      overflow-y: auto;
      font-size: 12px;
      font-family: monospace;
    }
  </style>
</head>
<body>
  <h2>MCP Browser Bridge</h2>
  
  <div class="status">
    <div class="status-indicator" id="statusIndicator"></div>
    <span id="statusText">Checking connection...</span>
  </div>
  
  <div class="info">
    <strong>Server:</strong> <span id="serverUrl">ws://localhost:3000</span><br>
    <strong>Available Tools:</strong> <span id="toolCount">0</span>
  </div>
  
  <button id="reconnectBtn">Reconnect</button>
  <button id="testBtn">Test Connection</button>
  
  <div class="log" id="log">
    <div>Waiting for activity...</div>
  </div>
  
  <script src="popup.js"></script>
</body>
</html>
```

### popup.js
```javascript
// Popup script for status display
let logContainer = document.getElementById('log');
let statusIndicator = document.getElementById('statusIndicator');
let statusText = document.getElementById('statusText');
let toolCount = document.getElementById('toolCount');

// Check connection status
chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
  updateStatus(response?.connected || false);
});

// Update UI based on connection status
function updateStatus(connected) {
  if (connected) {
    statusIndicator.className = 'status-indicator connected';
    statusText.textContent = 'Connected to MCP server';
  } else {
    statusIndicator.className = 'status-indicator disconnected';
    statusText.textContent = 'Disconnected from MCP server';
  }
}

// Reconnect button
document.getElementById('reconnectBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'reconnect' });
  addLog('Attempting to reconnect...');
});

// Test button
document.getElementById('testBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'test' });
  addLog('Sending test message...');
});

// Add log entry
function addLog(message) {
  const entry = document.createElement('div');
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

// Listen for updates from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'statusUpdate') {
    updateStatus(message.connected);
  } else if (message.type === 'log') {
    addLog(message.message);
  }
});
```

## MCP Server

### package.json
```json
{
  "name": "browser-mcp-server",
  "version": "1.0.0",
  "description": "MCP server for browser automation",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "ws": "^8.16.0",
    "express": "^4.18.2",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  }
}
```

### server.js
```javascript
const WebSocket = require('ws');
const express = require('express');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

// WebSocket server for Chrome Extension
const wss = new WebSocket.Server({ port: 3000 });
let chromeExtensionSocket = null;
let availableTools = [];

// MCP Server setup
const server = new Server(
  {
    name: 'browser-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle Chrome Extension connections
wss.on('connection', (ws) => {
  console.log('Chrome Extension connected');
  chromeExtensionSocket = ws;
  
  ws.on('message', (data) => {
    const message = JSON.parse(data);
    
    if (message.type === 'register') {
      availableTools = message.tools;
      console.log(`Registered ${availableTools.length} browser tools`);
      
      // Register tools with MCP server
      availableTools.forEach(tool => {
        server.setRequestHandler(`tools/call/${tool.name}`, async (request) => {
          return callBrowserTool(tool.name, request.params.arguments);
        });
      });
    } else if (message.id) {
      // Handle tool response
      handleToolResponse(message);
    }
  });
  
  ws.on('close', () => {
    console.log('Chrome Extension disconnected');
    chromeExtensionSocket = null;
  });
});

// Tool call tracking
const pendingCalls = new Map();

// Call browser tool through Chrome Extension
async function callBrowserTool(toolName, args) {
  if (!chromeExtensionSocket || chromeExtensionSocket.readyState !== WebSocket.OPEN) {
    throw new Error('Chrome Extension not connected');
  }
  
  const callId = Date.now().toString();
  
  return new Promise((resolve, reject) => {
    pendingCalls.set(callId, { resolve, reject });
    
    chromeExtensionSocket.send(JSON.stringify({
      id: callId,
      method: toolName,
      params: args
    }));
    
    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingCalls.has(callId)) {
        pendingCalls.delete(callId);
        reject(new Error('Tool call timeout'));
      }
    }, 30000);
  });
}

// Handle tool responses from Chrome Extension
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

// List available tools
server.setRequestHandler('tools/list', async () => {
  return {
    tools: availableTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
});

// Start MCP server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log('MCP Server running on stdio');
}

// Run the server
main().catch(console.error);

// Optional: HTTP endpoint for health checks
const app = express();
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    chromeExtensionConnected: chromeExtensionSocket !== null,
    availableTools: availableTools.length
  });
});
app.listen(3001, () => {
  console.log('Health check endpoint available at http://localhost:3001/health');
});
```

## Installation and Usage

### 1. Install the Chrome Extension
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension` directory
4. The extension icon should appear in your browser toolbar

### 2. Set up the MCP Server
```bash
cd mcp-server
npm install
npm start
```

### 3. Configure your MCP client
Add the browser server to your MCP configuration:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/mcp-server/server.js"],
      "env": {}
    }
  }
}
```

### 4. Available MCP Tools

Once connected, the following tools will be available through MCP:

- **browser_navigate**: Navigate to a URL
- **browser_get_tabs**: List all open tabs
- **browser_create_tab**: Create a new tab
- **browser_close_tab**: Close a specific tab
- **browser_execute_script**: Run JavaScript in the active tab
- **browser_get_page_content**: Extract text content from the page
- **browser_take_screenshot**: Capture a screenshot
- **browser_get_bookmarks**: Search bookmarks
- **browser_add_bookmark**: Create a new bookmark
- **browser_get_history**: Search browsing history
- **browser_get_cookies**: Get cookies for a domain
- **browser_fill_form**: Automatically fill form fields
- **browser_click_element**: Click elements on the page

## Security Considerations

1. **Permissions**: The extension requests broad permissions. Review and limit based on your needs.
2. **Local Only**: The WebSocket server runs on localhost only by default
3. **Content Security**: Be cautious when executing scripts or accessing sensitive data
4. **Authentication**: Consider adding authentication between the extension and MCP server

## Extending the Bridge

To add new browser functions:

1. Add the tool definition in `getAvailableTools()` in background.js
2. Implement the handler in `handleMCPRequest()`
3. The tool will automatically be registered with the MCP server

## Troubleshooting

### Common Issues

- **Extension not connecting**: Check that the MCP server is running on port 3000
- **Tools not available**: Verify the extension is loaded and check the popup for connection status
- **Permission errors**: Ensure the extension has the necessary permissions in manifest.json

### Installation Issues

- **"Cannot find module 'ws'" error**: Run `npm install` in the `mcp-server` directory to install dependencies
  ```bash
  cd mcp-server
  npm install
  ```

### Connection Stability

The server now includes improved connection stability features:

- **Heartbeat monitoring**: Automatic ping/pong between extension and server
- **Graceful reconnection**: Extension automatically reconnects with exponential backoff
- **Better error handling**: More detailed error messages and logging
- **Increased timeouts**: Tool calls now have 60-second timeout (previously 30s)

### Health Monitoring

Check server status using the health endpoints:

```bash
# Check server health
curl http://localhost:3001/health

# List available tools
curl http://localhost:3001/tools
```

Or use npm scripts:
```bash
cd mcp-server
npm run health
npm run tools
```

### Debug Logging

The server logs detailed information to stderr for debugging:
- Connection events
- Tool call requests and responses
- Error messages with context