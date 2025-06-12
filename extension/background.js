// MCP Server connection configuration
const MCP_SERVER_URL = "ws://localhost:3000";
let mcpSocket = null;
let reconnectInterval = null;
let reconnectAttempts = 0;
let pingInterval = null;

// Ping mechanism to keep connection alive
function startPingInterval() {
  // Clear any existing ping interval
  if (pingInterval) {
    clearInterval(pingInterval);
  }
  
  // Send ping every 20 seconds
  pingInterval = setInterval(() => {
    if (mcpSocket && mcpSocket.readyState === WebSocket.OPEN) {
      mcpSocket.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
    } else {
      // Stop pinging if connection is not open
      clearInterval(pingInterval);
      pingInterval = null;
    }
  }, 20000);
}

function stopPingInterval() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// Initialize WebSocket connection to MCP server
function connectToMCPServer() {
  if (
    mcpSocket &&
    (mcpSocket.readyState === WebSocket.OPEN ||
      mcpSocket.readyState === WebSocket.CONNECTING)
  ) {
    console.log("Already connected or connecting to MCP server");
    return;
  }

  console.log("Attempting to connect to MCP server at", MCP_SERVER_URL);

  try {
    mcpSocket = new WebSocket(MCP_SERVER_URL);

    mcpSocket.onopen = () => {
      console.log("Connected to MCP server");
      clearInterval(reconnectInterval);
      reconnectInterval = null;
      reconnectAttempts = 0;

      // Register available browser functions
      mcpSocket.send(
        JSON.stringify({
          type: "register",
          tools: getAvailableTools(),
        })
      );

      // Start ping mechanism to keep connection alive
      startPingInterval();

      // Notify popup of connection
      try {
        chrome.runtime.sendMessage({ type: "statusUpdate", connected: true });
      } catch (e) {
        // Popup might not be open
      }
    };

    mcpSocket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        await handleMCPRequest(message);
      } catch (error) {
        console.error("Error handling message:", error);
      }
    };

    mcpSocket.onclose = (event) => {
      console.log("Disconnected from MCP server", event.code, event.reason);

      // Stop ping interval
      stopPingInterval();

      // Notify popup of disconnection
      try {
        chrome.runtime.sendMessage({ type: "statusUpdate", connected: false });
      } catch (e) {
        // Popup might not be open
      }

      // Reset socket reference
      mcpSocket = null;

      // Attempt to reconnect with exponential backoff
      if (!reconnectInterval) {
        const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts), 30000);
        reconnectAttempts++;
        console.log(`Reconnecting in ${delay / 1000} seconds...`);
        reconnectInterval = setTimeout(() => {
          reconnectInterval = null;
          connectToMCPServer();
        }, delay);
      }
    };

    mcpSocket.onerror = (error) => {
      console.error("MCP connection error:", error);
      console.error("Make sure the MCP server is running on port 3000");
    };
  } catch (error) {
    console.error("Failed to create WebSocket:", error);
    
    // Stop ping interval if it was running
    stopPingInterval();
    
    // Try again in 5 seconds
    if (!reconnectInterval) {
      reconnectInterval = setTimeout(() => {
        reconnectInterval = null;
        connectToMCPServer();
      }, 5000);
    }
  }
}

// Define available browser tools for MCP
function getAvailableTools() {
  return [
    {
      name: "browser_navigate",
      description: "Navigate to a URL in the active tab",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to" },
        },
        required: ["url"],
      },
    },
    {
      name: "browser_get_tabs",
      description: "Get all open tabs",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "browser_create_tab",
      description: "Create a new tab",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL for the new tab" },
          active: {
            type: "boolean",
            description: "Whether to make the tab active",
          },
        },
      },
    },
    {
      name: "browser_close_tab",
      description: "Close a tab by ID",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "number", description: "ID of the tab to close" },
        },
        required: ["tabId"],
      },
    },
    {
      name: "browser_execute_script",
      description: "Execute JavaScript in the active tab",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript code to execute" },
        },
        required: ["code"],
      },
    },
    {
      name: "browser_get_page_content",
      description: "Get the content of the active page",
      inputSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector to get specific content",
          },
        },
      },
    },
    {
      name: "browser_take_screenshot",
      description: "Take a screenshot of the active tab",
      inputSchema: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["png", "jpeg"],
            description: "Image format",
          },
        },
      },
    },
    {
      name: "browser_get_bookmarks",
      description: "Get browser bookmarks",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for bookmarks" },
        },
      },
    },
    {
      name: "browser_add_bookmark",
      description: "Add a bookmark",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Bookmark title" },
          url: { type: "string", description: "Bookmark URL" },
        },
        required: ["title", "url"],
      },
    },
    {
      name: "browser_get_history",
      description: "Search browser history",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          maxResults: {
            type: "number",
            description: "Maximum number of results",
          },
        },
      },
    },
    {
      name: "browser_get_cookies",
      description: "Get cookies for a domain",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Domain to get cookies for" },
        },
      },
    },
    {
      name: "browser_fill_form",
      description: "Fill a form on the current page",
      inputSchema: {
        type: "object",
        properties: {
          formData: {
            type: "object",
            description: "Key-value pairs of form field names/IDs and values",
          },
        },
        required: ["formData"],
      },
    },
    {
      name: "browser_click_element",
      description: "Click an element on the page",
      inputSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector of element to click",
          },
        },
        required: ["selector"],
      },
    },
  ];
}

// Handle MCP requests
async function handleMCPRequest(message) {
  const { id, method, params, type } = message;

  // Handle ping/pong messages for connection keepalive
  if (type === "ping") {
    mcpSocket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
    return;
  }
  
  if (type === "pong") {
    // Server responded to our ping
    return;
  }

  // Handle regular method calls
  if (!method) {
    console.warn("Received message without method:", message);
    return;
  }

  try {
    let result;

    switch (method) {
      case "browser_navigate":
        result = await navigateToUrl(params.url);
        break;
      case "browser_get_tabs":
        result = await getTabs();
        break;
      case "browser_create_tab":
        result = await createTab(params);
        break;
      case "browser_close_tab":
        result = await closeTab(params.tabId);
        break;
      case "browser_execute_script":
        result = await executeScript(params.code);
        break;
      case "browser_get_page_content":
        result = await getPageContent(params.selector);
        break;
      case "browser_take_screenshot":
        result = await takeScreenshot(params.format);
        break;
      case "browser_get_bookmarks":
        result = await getBookmarks(params.query);
        break;
      case "browser_add_bookmark":
        result = await addBookmark(params);
        break;
      case "browser_get_history":
        result = await getHistory(params);
        break;
      case "browser_get_cookies":
        result = await getCookies(params.domain);
        break;
      case "browser_fill_form":
        result = await fillForm(params.formData);
        break;
      case "browser_click_element":
        result = await clickElement(params.selector);
        break;
      default:
        throw new Error(`Unknown method: ${method}`);
    }

    // Send success response
    mcpSocket.send(
      JSON.stringify({
        id,
        result,
      })
    );
  } catch (error) {
    // Send error response
    mcpSocket.send(
      JSON.stringify({
        id,
        error: {
          message: error.message,
          code: -32603,
        },
      })
    );
  }
}

// Browser function implementations
async function navigateToUrl(url) {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  await chrome.tabs.update(activeTab.id, { url });
  return { success: true, tabId: activeTab.id };
}

async function getTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    windowId: tab.windowId,
  }));
}

async function createTab(params) {
  const tab = await chrome.tabs.create({
    url: params.url || "about:blank",
    active: params.active !== false,
  });
  return { id: tab.id, windowId: tab.windowId };
}

async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  return { success: true };
}

async function executeScript(code) {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: new Function(code),
  });
  return results[0].result;
}

async function getPageContent(selector) {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: (sel) => {
      if (sel) {
        const element = document.querySelector(sel);
        return element ? element.innerText : null;
      }
      return document.body.innerText;
    },
    args: [selector],
  });
  return results[0].result;
}

async function takeScreenshot(format = "png") {
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
    url: params.url,
  });
  return bookmark;
}

async function getHistory(params) {
  const historyItems = await chrome.history.search({
    text: params.query || "",
    maxResults: params.maxResults || 100,
  });
  return historyItems;
}

async function getCookies(domain) {
  const cookies = await chrome.cookies.getAll({ domain });
  return cookies;
}

async function fillForm(formData) {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: (data) => {
      for (const [key, value] of Object.entries(data)) {
        const element = document.querySelector(`[name="${key}"], #${key}`);
        if (element) {
          element.value = value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      return { success: true, filled: Object.keys(data).length };
    },
    args: [formData],
  });
  return results[0].result;
}

async function clickElement(selector) {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
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
    args: [selector],
  });
  return results[0].result;
}

// Initialize connection when extension loads
connectToMCPServer();

// Heartbeat to keep connection alive
setInterval(() => {
  if (mcpSocket && mcpSocket.readyState === WebSocket.OPEN) {
    mcpSocket.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
  }
}, 30000); // Every 30 seconds

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getStatus") {
    sendResponse({
      connected: mcpSocket && mcpSocket.readyState === WebSocket.OPEN,
    });
  } else if (request.action === "reconnect") {
    connectToMCPServer();
    sendResponse({ success: true });
  } else if (request.action === "test") {
    if (mcpSocket && mcpSocket.readyState === WebSocket.OPEN) {
      mcpSocket.send(JSON.stringify({ type: "test", timestamp: Date.now() }));
    }
    sendResponse({ success: true });
  }
  return true; // Keep the message channel open
});
