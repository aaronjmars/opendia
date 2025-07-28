#!/bin/bash

# OpenDia DXT Build Script - Fixed Version
# Run this from the OpenDia project root directory

set -e  # Exit on any error

echo "🚀 Building OpenDia DXT package..."

# Check if we're in the right directory
if [ ! -f "opendia-mcp/package.json" ]; then
    echo "❌ Error: Please run this script from the OpenDia project root directory"
    echo "   Expected to find: opendia-mcp/package.json"
    echo "   Current directory: $(pwd)"
    exit 1
fi

if [ ! -d "opendia-extension" ]; then
    echo "❌ Error: opendia-extension directory not found"
    exit 1
fi

# Clean and create dist directory
echo "🧹 Cleaning previous build..."
rm -rf dist
mkdir -p dist/opendia-dxt

echo "📦 Setting up package..."

# Copy server files
cp opendia-mcp/server.js dist/opendia-dxt/

# Create optimized package.json for DXT
cat > dist/opendia-dxt/package.json << 'EOF'
{
  "name": "opendia",
  "version": "1.1.0",
  "description": "🎯 OpenDia - The open alternative to Dia. Connect your browser to AI models with anti-detection bypass for Twitter/X, LinkedIn, Facebook",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "keywords": [
    "mcp",
    "browser", 
    "automation",
    "ai",
    "claude",
    "chrome",
    "firefox",
    "extension",
    "twitter",
    "linkedin", 
    "facebook",
    "anti-detection",
    "dxt"
  ],
  "author": "Aaron Elijah Mars <aaronjmars@proton.me>",
  "license": "MIT",
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.21.2", 
    "ws": "^8.18.0"
  },
  "engines": {
    "node": ">=16.0.0"
  }
}
EOF

# Install dependencies
echo "⬇️  Installing dependencies..."
cd dist/opendia-dxt
npm install --production --silent
cd ../..

# Copy browser extension
echo "🌐 Copying browser extension..."
cp -r opendia-extension dist/opendia-dxt/extension

# Copy logo/icon files for DXT - try multiple sources
echo "🎨 Copying logo files..."
LOGO_COPIED=false

# Try different icon files from the extension
for icon_file in "icon-128.png" "icon-48.png" "icon-32.png" "icon-16.png" "icon.png"; do
    if [ -f "opendia-extension/$icon_file" ]; then
        cp "opendia-extension/$icon_file" dist/opendia-dxt/icon.png
        echo "✅ Logo copied from extension/$icon_file"
        LOGO_COPIED=true
        break
    fi
done

# If no extension icon found, check root directory
if [ "$LOGO_COPIED" = false ]; then
    for icon_file in "icon.png" "logo.png" "opendia.png"; do
        if [ -f "$icon_file" ]; then
            cp "$icon_file" dist/opendia-dxt/icon.png
            echo "✅ Logo copied from $icon_file"
            LOGO_COPIED=true
            break
        fi
    done
fi

# Create a simple placeholder if no icon found
if [ "$LOGO_COPIED" = false ]; then
    echo "⚠️  No logo file found, you may need to add icon.png manually to dist/opendia-dxt/"
fi

# Create DXT manifest - CORRECT FORMAT BASED ON WORKING EXAMPLES
echo "📋 Creating DXT manifest..."
cat > dist/opendia-dxt/manifest.json << 'EOF'
{
  "dxt_version": "0.1",
  "name": "opendia",
  "display_name": "OpenDia - Browser Automation", 
  "version": "1.1.0",
  "description": "🎯 OpenDia - The open alternative to Dia. Connect your browser to AI models with anti-detection bypass for Twitter/X, LinkedIn, Facebook + universal automation",
  "author": {
    "name": "Aaron Elijah Mars",
    "email": "aaronjmars@proton.me",
    "url": "https://github.com/aaronjmars/opendia"
  },
  "homepage": "https://github.com/aaronjmars/opendia",
  "license": "MIT", 
  "keywords": ["browser", "automation", "mcp", "ai", "claude", "chrome", "firefox", "extension", "twitter", "linkedin", "facebook", "anti-detection"],
  "icon": "icon.png",
  
  "server": {
    "type": "node",
    "entry_point": "server.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server.js"],
      "env": {
        "NODE_ENV": "production",
        "WS_PORT": "${user_config.ws_port}",
        "HTTP_PORT": "${user_config.http_port}",
        "ENABLE_TUNNEL": "${user_config.enable_tunnel}",
        "SAFETY_MODE": "${user_config.safety_mode}"
      }
    }
  },
  
  "user_config": {
    "ws_port": {
      "type": "number",
      "title": "WebSocket Port",
      "description": "Port for Chrome/Firefox extension connection",
      "default": 5555,
      "min": 1024,
      "max": 65535
    },
    "http_port": {
      "type": "number",
      "title": "HTTP Port", 
      "description": "Port for HTTP/SSE server",
      "default": 5556,
      "min": 1024,
      "max": 65535
    },
    "enable_tunnel": {
      "type": "boolean",
      "title": "Auto-Tunnel",
      "description": "Automatically create ngrok tunnel for online AI access (requires ngrok)",
      "default": false
    },
    "safety_mode": {
      "type": "boolean",
      "title": "Safety Mode",
      "description": "Block write/edit tools (element_click, element_fill) by default",
      "default": false
    }
  },
  
  "tools": [
    {
      "name": "page_analyze",
      "description": "🔍 Analyze any tab without switching! Two-phase intelligent page analysis"
    },
    {
      "name": "page_extract_content", 
      "description": "📄 Extract content from any tab without switching!"
    },
    {
      "name": "element_click",
      "description": "🖱️ Click elements with anti-detection bypass for social platforms"
    },
    {
      "name": "element_fill",
      "description": "✏️ Fill forms with anti-detection bypass for Twitter/X, LinkedIn, Facebook"
    },
    {
      "name": "page_navigate",
      "description": "🧭 Navigate to URLs with wait conditions"
    },
    {
      "name": "page_wait_for",
      "description": "⏳ Wait for elements or conditions"
    },
    {
      "name": "tab_create",
      "description": "📱 Create single or multiple tabs with batch support"
    },
    {
      "name": "tab_close",
      "description": "❌ Close specific tab(s) by ID"
    },
    {
      "name": "tab_list",
      "description": "📋 Get list of all open tabs with IDs"
    },
    {
      "name": "tab_switch",
      "description": "🔄 Switch to specific tab by ID"
    },
    {
      "name": "element_get_state",
      "description": "🔍 Get detailed element state information"
    },
    {
      "name": "get_bookmarks",
      "description": "📚 Get all bookmarks or search for specific ones"
    },
    {
      "name": "add_bookmark",
      "description": "➕ Add new bookmark"
    },
    {
      "name": "get_history",
      "description": "🕒 Search browser history with comprehensive filters"
    },
    {
      "name": "get_selected_text",
      "description": "📝 Get selected text from any tab"
    },
    {
      "name": "page_scroll",
      "description": "📜 Scroll any tab without switching"
    },
    {
      "name": "get_page_links",
      "description": "🔗 Get all hyperlinks with smart filtering"
    },
    {
      "name": "page_style",
      "description": "🎨 Transform page appearance with themes and effects"
    }
  ]
}
EOF

# Validate JSON syntax
echo "🔍 Validating manifest.json..."
if ! python3 -m json.tool dist/opendia-dxt/manifest.json > /dev/null 2>&1; then
    echo "❌ Error: Invalid JSON in manifest.json"
    exit 1
fi
echo "✅ Manifest JSON is valid"

# Copy documentation
echo "📝 Adding documentation..."
cp README.md dist/opendia-dxt/ 2>/dev/null || echo "⚠️  README.md not found, skipping"
cp LICENSE dist/opendia-dxt/ 2>/dev/null || echo "⚠️  LICENSE not found, skipping"

# Create extension installation guide
cat > dist/opendia-dxt/EXTENSION_INSTALL.md << 'EOF'
# OpenDia Browser Extension Installation

**🔗 Official Repository:** https://github.com/aaronjmars/opendia

## Complete Installation Guide

### Step 1: Install the DXT Package (Already Done!)
✅ You've successfully installed the OpenDia DXT package in Claude Desktop

### Step 2: Install Browser Extension

**📦 Get Latest Extension:**
Download the latest extension from: https://github.com/aaronjmars/opendia/releases

**Or use the included extension in this DXT package:**

#### For Chrome/Chromium Browsers

1. **Enable Developer Mode**
   - Go to `chrome://extensions/`
   - Toggle "Developer mode" in the top right

2. **Install Extension**
   - Click "Load unpacked"
   - Select the `extension/` folder from this DXT package
   - Extension should appear in your extensions list with OpenDia icon

#### For Firefox

1. **Load Temporary Add-on**
   - Go to `about:debugging#/runtime/this-firefox`
   - Click "Load Temporary Add-on..."
   - Select the `manifest-firefox.json` file from the `extension/` folder

> **Firefox Note**: Extensions are loaded as temporary add-ons and will be removed when Firefox restarts. For permanent installation, use the signed extension from GitHub releases.

### Step 3: Verify Everything Works

1. **Check Extension Status**
   - Click the OpenDia extension icon in your browser
   - Should show "Connected to MCP server"
   - Green status indicator means ready to use

2. **Test in Claude Desktop**
   - Ask Claude: "List my open browser tabs"
   - Should return your current tabs if working correctly

## Supported Browsers
- ✅ **Mozilla Firefox** (Manifest V2)
- ✅ **Google Chrome** (Manifest V3)
- ✅ **Arc Browser, Microsoft Edge, Brave Browser, Opera**
- ✅ **Any Chromium-based browser**

## Key Features
🎯 **Anti-detection bypass** for Twitter/X, LinkedIn, Facebook
📱 **Smart automation** and intelligent page analysis
🔧 **Form filling** with enhanced compatibility
📊 **Multi-tab workflows** and background operations
🎨 **Page styling** and visual customization
🔒 **Privacy-first** - everything runs locally

## Getting Help

- **📖 Full Documentation:** https://github.com/aaronjmars/opendia
- **🐛 Report Issues:** https://github.com/aaronjmars/opendia/issues
- **💬 Discussions:** https://github.com/aaronjmars/opendia/discussions

## What's Next?

Try these example prompts in Claude Desktop:
- "List my open browser tabs"
- "Analyze the content of my current tab"
- "Apply a dark theme to this webpage"
- "Extract the main article text from this page"

**🚀 Ready to supercharge your browser with AI!**
EOF

# Verify structure before zipping
echo "🔍 Verifying DXT structure..."
echo "📋 Files in DXT directory:"
ls -la dist/opendia-dxt/

# Check if icon exists and show its details
if [ -f "dist/opendia-dxt/icon.png" ]; then
    echo "✅ Icon file found:"
    file dist/opendia-dxt/icon.png
    ls -lh dist/opendia-dxt/icon.png
else
    echo "❌ Icon file missing!"
fi

# Verify manifest.json exists and is at root level
if [ ! -f "dist/opendia-dxt/manifest.json" ]; then
    echo "❌ Error: manifest.json not found!"
    exit 1
fi

echo "✅ Structure verified"

# Create the DXT archive - CRITICAL: ZIP from inside the directory
echo "🗜️  Creating DXT archive..."
cd dist/opendia-dxt
zip -r ../opendia.dxt . -q
cd ../..

# Verify the DXT file structure
echo "🔍 Verifying DXT file contents..."
if ! unzip -l dist/opendia.dxt | grep -q "manifest.json"; then
    echo "❌ Error: manifest.json not found in DXT file!"
    echo "DXT contents:"
    unzip -l dist/opendia.dxt
    exit 1
fi

# Get file size
DXT_SIZE=$(du -h dist/opendia.dxt | cut -f1)

echo ""
echo "✅ DXT package created successfully!"
echo "📦 File: dist/opendia.dxt"
echo "💾 Size: $DXT_SIZE"
echo ""
echo "📋 DXT Contents:"
unzip -l dist/opendia.dxt | head -10
echo ""
echo "🚀 Installation:"
echo "1. Double-click the .dxt file"
echo "2. Or: Claude Desktop Settings → Extensions → Install Extension"
echo "3. Install Chrome/Firefox extension from extension/ folder"
echo ""
echo "🎯 Features ready: Anti-detection bypass + universal automation"