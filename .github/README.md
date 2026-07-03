# OpenDia <img src="../opendia-extension/icons/icon-128.png" alt="OpenDia" width="32" height="32">

**The open alternative to Dia / Perplexity Comet**  
Connect your browser to AI models. 
No browser switching needed—works seamlessly with Chrome, Firefox, and any Chromium browser. Private, local-first & MCP focused.
If you are not technical / never used MCPs before, we recommend using **[Perplexity Comet](https://pplx.ai/leosimon)**.

[![npm version](https://img.shields.io/npm/v/opendia)](https://www.npmjs.com/package/opendia)
[![GitHub release](https://img.shields.io/github/release/aaronjmars/opendia.svg)](https://github.com/aaronjmars/opendia/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 📺 See it in Action

![OpenDia Demo](../preview.gif)

## 🚀 What is OpenDia?

OpenDia lets AI models control your browser automatically. **The key advantage? It leverages everything you already have**—your logged-in accounts, saved passwords, cookies, wallets, and browsing history. No need to start from scratch or switch contexts.

**🔑 Use Your Existing Digital Life:**
- ✅ **Logged-in accounts**: Post to Twitter/X, LinkedIn, Facebook with your existing sessions
- ✅ **Browser data**: Access your bookmarks, history, and saved passwords
- ✅ **Extensions & wallets**: Use MetaMask, password managers, or any installed extensions
- ✅ **Cookies & sessions**: Stay authenticated across all your favorite sites
- ✅ **Local testing**: Perfect for development with Cursor - test with real user sessions

**✨ Key Benefits:**
- 🔄 **Universal AI Support**: Works with Claude, ChatGPT, Cursor and even local models
- 🎯 **Anti-Detection**: Specialized bypasses for Twitter/X, LinkedIn, Facebook
- 📱 **Smart Automation**: AI understands your pages and finds the right elements
- 🛡️ **Privacy-First**: Everything runs locally, your data stays with you
- ⚡ **Zero Setup**: Get started with one command

## 🌐 Browser Support

Works with **Chrome, Firefox, and any Chromium-based browser**:
- ✅ **Google Chrome**
- ✅ **Arc**
- ✅ **Mozilla Firefox**
- ✅ **Microsoft Edge**
- ✅ **Brave**
- ✅ **Opera**
- ✅ **Any Chromium based browser**

Also perfect for **Cursor users** who want to automate their local testing and development workflows!

## 🔌 Compatible AI Clients

OpenDia exposes a standard MCP server, so it works with any client that speaks the protocol.

**Tested:**
- **Claude Desktop** — paste the config below, restart.
- **Claude Code** — same MCP config, runs from any terminal.
- **Cursor** — add via Settings → MCP, or paste the same JSON.
- **ChatGPT** — works with Auto-Tunnel mode (`npx opendia --tunnel`), then add the ngrok URL as a connector.

**Should work** (any MCP-compatible client): Windsurf, Zed, Continue, Cline, Goose, Open WebUI.

Wired it up with something else? Open a PR — the list grows as MCP grows.

## 🎬 What You Can Do

**Real workflows you can try today:**

### 📰 Content & Social Media
- **"Summarize all the articles I read today and post a Twitter thread about the key insights"**
- **"Find interesting articles related to AI from my bookmarks and create a reading list"**
- **"Read this article and post a thoughtful comment on the LinkedIn version"**
- **"Check my recent Twitter bookmarks and summarize the main themes"**

### 📧 Productivity & Research
- **"Browse my latest emails and tell me what needs urgent attention"**
- **"Find all the GitHub repos I visited this week and create a summary report"**
- **"Extract the main points from this research paper and save them to my notes"**
- **"Search my browsing history for that article about AI safety I read last month"**

### 🤖 Development & Testing (Perfect for Cursor!)
- **"Test my web app's signup flow and take screenshots at each step"**
- **"Fill out this form with test data and check if validation works"**
- **"Navigate through my app and check if all the buttons work properly"**
- **"Use my connected wallet to test this DeFi interface"**

### 🔄 Advanced Automation
- **"Open tabs for all my daily news sources and summarize the top stories"**
- **"Draft replies to my unread messages based on the context"**
- **"Monitor this webpage and notify me when the content changes"**
- **"Automatically bookmark interesting articles I'm reading"**

### 🎨 Visual Customization & Fun
- **"Apply a cyberpunk theme to this documentation site to make it more engaging"**
- **"Make this page dark mode with green text for late-night reading"**
- **"Add rainbow party effects to celebrate finishing this project"**
- **"Transform this boring form with a retro 80s theme while I fill it out"**
- **"Use high contrast styling so I can read this better"**

## ⚡ Quick Start

### 1. Install the Browser Extension

**For Chrome/Chromium browsers:**
1. Download `opendia-chrome-1.1.0.zip` from [releases](https://github.com/aaronjmars/opendia/releases)
2. Extract the zip file to a folder
3. Go to `chrome://extensions/` (or your browser's extension page)
4. Enable "Developer mode"
5. Click "Load unpacked" and select the extracted folder

**For Firefox:**
1. Download `opendia-firefox-1.1.0.zip` from [releases](https://github.com/aaronjmars/opendia/releases)
2. Extract the zip file to a folder
3. Go to `about:debugging#/runtime/this-firefox`
4. Click "Load Temporary Add-on..."
5. Select the `manifest.json` file from the extracted folder

> **Note**: Firefox extensions are loaded as temporary add-ons and will be removed when Firefox restarts. This is a Firefox limitation for unsigned extensions.

### 2. Connect to Your AI

**Option 1: Double-click Installation (Recommended)**
1. Download the `opendia.dxt` file from [releases](https://github.com/aaronjmars/opendia/releases)
2. Double-click the `.dxt` file to install automatically
3. The MCP will be added to your Claude Desktop configuration

**Option 2: Manual Configuration**
Add to your Claude Desktop configuration:
```json
{
  "mcpServers": {
    "opendia": {
      "command": "npx",
      "args": ["opendia"]
    }
  }
}
```

**For Cursor or other AI tools**, use the same configuration or follow their specific setup instructions.

## Usage Modes

### Local Mode (Default)
```bash
npx opendia
```
- Chrome extension: ws://localhost:5555 (auto-discovery enabled)
- Claude Desktop: stdio (existing config)
- Local SSE: http://localhost:5556/sse

### Port Configuration
```bash
# Use custom ports
npx opendia --port=6000              # Uses 6000 (WebSocket) + 6001 (HTTP)
npx opendia --ws-port=5555 --http-port=5556  # Specify individually

# Handle port conflicts  
# Note: Existing OpenDia processes are automatically terminated on startup
```

### Auto-Tunnel Mode
```bash
npx opendia --tunnel
```
- Automatically creates ngrok tunnel
- Copy URL for ChatGPT/online AI services
- Local functionality preserved

**Note**: For auto-tunneling to work, you need ngrok installed:

**macOS:**
```bash
brew install ngrok
```

**Windows:**
```bash
# Using Chocolatey
choco install ngrok

# Or download from https://ngrok.com/download
```

**Linux:**
```bash
# Ubuntu/Debian
curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install ngrok

# Or download from https://ngrok.com/download
```

Then get your free authtoken from https://dashboard.ngrok.com/get-started/your-authtoken and run:
```bash
ngrok config add-authtoken YOUR_TOKEN_HERE
```

## 🛠️ Capabilities

OpenDia gives AI models **18 powerful browser tools**:

### 🎯 Smart Page Understanding
- **Analyze any webpage** - AI automatically finds buttons, forms, and interactive elements
- **Extract content intelligently** - Get clean text from articles, social posts, or search results
- **Understand context** - AI knows what type of page it's looking at and how to interact with it

### 🖱️ Natural Interactions  
- **Click anything** - Buttons, links, menus - AI finds and clicks the right elements
- **Fill forms smartly** - Works even on complex sites like Twitter, LinkedIn, Facebook
- **Navigate seamlessly** - Go to pages, scroll, wait for content to load
- **Handle modern web apps** - Bypasses detection on social platforms

### 📑 Tab & Window Management
- **Multi-tab workflows** - Open, close, switch between tabs automatically
- **Organize your workspace** - Let AI manage your browser tabs efficiently
- **Coordinate complex tasks** - Work across multiple sites simultaneously

### 📊 Access Your Browser Data
- **Bookmarks & History** - Find that article you read last week
- **Current page content** - Get selected text, links, or full page content
- **Real-time information** - Work with whatever's currently on your screen

### 🛡️ Anti-Detection Features
- **Social media posting** - Bypass automation detection on Twitter/X, LinkedIn, Facebook
- **Natural interactions** - Mimics human behavior to avoid triggering security measures
- **Reliable automation** - Works consistently even on sites that block typical automation tools

### 🎨 Page Styling & Customization
- **Transform any website** - Apply fun themes, custom colors, and visual effects
- **Preset themes** - Dark hacker, retro 80s, rainbow party, minimalist zen, and more
- **AI mood styling** - Describe a mood and get matching visual design
- **Interactive effects** - Matrix rain, floating particles, neon glow, and cursor trails
- **Accessibility themes** - High contrast and readable designs for better visibility

## 💬 Example Prompts to Try

Once everything is set up, try asking your AI:

**Content Creation:**
> *"Read the article on this page and create a Twitter thread summarizing the main points"*

**Research & Analysis:**
> *"Look through my browser history from this week and find articles about machine learning. Summarize the key trends."*

**Social Media Management:**
> *"Check my Twitter bookmarks and organize them into categories. Create a summary of each category."*

**Productivity:**
> *"Open tabs for my usual morning reading sites and give me a briefing of today's top stories"*

**Development Testing:**
> *"Fill out this contact form with test data and check if the submission works properly"*

**Personal Assistant:**
> *"Find that GitHub repo I was looking at yesterday about React components and bookmark it for later"*

**Page Styling & Fun:**
> *"Apply a dark hacker theme to this page to make it look more interesting"*

> *"Make this boring documentation page feel like a cozy coffee shop"*

> *"Add some matrix rain effects to this page for 30 seconds for a cool screenshot"*

> *"Transform this page with a high contrast theme for better readability"*

## 🏗️ How It Works

```mermaid
graph LR
    A[AI Model] --> B[OpenDia Server]
    B --> C[Browser Extension]
    C --> D[Your Browser]
    D --> E[Any Website]
```

1. **You ask** your AI to do something browser-related
2. **AI calls** OpenDia tools to understand and interact with pages
3. **OpenDia controls** your browser through the extension
4. **You get results** - AI can see what happened and respond intelligently

## 🔒 Security & Privacy

**Your data stays private**:
- ✅ **Everything runs locally** - No cloud processing of your browsing data
- ✅ **You control access** - Extension only works when you want it to
- ✅ **Open source** - Full transparency of what the code does
- ✅ **No tracking** - We don't collect or store any of your information

**Important**: This tool requires broad browser permissions to function. Only use with AI models you trust, and in environments where you're comfortable with browser automation.

## 🤝 Contributing

Love to have your help making OpenDia better!

### Quick Development Setup
```bash
git clone https://github.com/aaronjmars/opendia.git
cd opendia

# Start the server
cd opendia-mcp
npm install
npm start

# Load extension in your browser  
# Chrome: Go to chrome://extensions/ → Developer mode → Load unpacked: ./opendia-extension/dist/chrome
# Firefox: Go to about:debugging#/runtime/this-firefox → Load Temporary Add-on → ./opendia-extension/dist/firefox/manifest.json
# Extension will auto-connect to server on localhost:5555
```

### Ways to Contribute
- 🐛 **Report bugs** via [GitHub Issues](https://github.com/aaronjmars/opendia/issues)
- 💡 **Share it on social medias**
- 🔧 **Add new browser capabilities** 
- 📖 **Improve documentation**
- 🧪 **Test with different AI models**

## 📝 License

MIT License - see [LICENSE](../LICENSE) for details.

---

**Ready to supercharge your browser with AI? Get started with `npx opendia`! 🚀**
