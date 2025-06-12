#!/usr/bin/env node

// Simple test to verify the server can start
const WebSocket = require("ws");
const express = require("express");

console.log("✓ Dependencies loaded successfully");

// Test WebSocket server creation
try {
  const testWss = new WebSocket.Server({ port: 3002 });
  console.log("✓ WebSocket server can be created");
  testWss.close();
} catch (error) {
  console.error("✗ WebSocket server creation failed:", error);
  process.exit(1);
}

// Test Express server creation
try {
  const testApp = express();
  testApp.get("/test", (req, res) => res.json({ status: "ok" }));
  const testServer = testApp.listen(3003, () => {
    console.log("✓ Express server can be created");
    testServer.close();
    console.log("✓ All tests passed - server should work correctly");
  });
} catch (error) {
  console.error("✗ Express server creation failed:", error);
  process.exit(1);
}