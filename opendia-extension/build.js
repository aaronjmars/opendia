const fs = require('fs-extra');
const path = require('path');

async function buildForBrowser(browser) {
  const buildDir = `dist/${browser}`;
  
  console.log(`🔧 Building ${browser} extension...`);
  
  // Clean and create build directory
  await fs.remove(buildDir);
  await fs.ensureDir(buildDir);
  
  // Copy common files
  await fs.copy('src', path.join(buildDir, 'src'));
  await fs.copy('icons', path.join(buildDir, 'icons'));
  
  // Copy logo files for animated popup
  if (await fs.pathExists('logo.mp4')) {
    await fs.copy('logo.mp4', path.join(buildDir, 'logo.mp4'));
  }
  
  // Copy browser-specific manifest
  await fs.copy(
    `manifest-${browser}.json`,
    path.join(buildDir, 'manifest.json')
  );
  
  // Copy polyfill
  await fs.copy(
    'node_modules/webextension-polyfill/dist/browser-polyfill.min.js',
    path.join(buildDir, 'src/polyfill/browser-polyfill.min.js')
  );
  
  // Browser-specific post-processing
  if (browser === 'chrome') {
    console.log('📦 Chrome MV3: Service worker mode enabled');
    // No additional processing needed for Chrome
  } else if (browser === 'firefox') {
    console.log('🦊 Firefox MV2: Background page mode enabled');
    // No additional processing needed for Firefox
  }
  
  console.log(`✅ ${browser} extension built successfully in ${buildDir}`);
}

async function buildAll() {
  console.log('🚀 Building extensions for all browsers...');
  
  try {
    await buildForBrowser('chrome');
    await buildForBrowser('firefox');
    
    console.log('🎉 All extensions built successfully!');
    console.log('');
    console.log('📁 Build outputs:');
    console.log('   Chrome MV3: dist/chrome/');
    console.log('   Firefox MV2: dist/firefox/');
    console.log('');
    console.log('🧪 Testing instructions:');
    console.log('   Chrome: Load dist/chrome in chrome://extensions (Developer mode)');
    console.log('   Firefox: Load dist/firefox in about:debugging#/runtime/this-firefox');
    
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

async function createPackages() {
  console.log('📦 Creating distribution packages...');
  
  const { execSync } = require('child_process');
  
  try {
    // Create Chrome package
    console.log('Creating Chrome package...');
    execSync('cd dist/chrome && zip -r ../opendia-chrome.zip .', { stdio: 'inherit' });
    
    // Create Firefox package (using web-ext if available)
    console.log('Creating Firefox package...');
    try {
      execSync('cd dist/firefox && web-ext build --overwrite-dest', { stdio: 'inherit' });
      console.log('✅ Firefox package created with web-ext');
    } catch (e) {
      // Fallback to zip if web-ext is not available
      console.log('⚠️ web-ext not available, using zip fallback');
      execSync('cd dist/firefox && zip -r ../opendia-firefox.zip .', { stdio: 'inherit' });
    }
    
    console.log('📦 Distribution packages created:');
    console.log('   Chrome: dist/opendia-chrome.zip');
    console.log('   Firefox: dist/opendia-firefox.zip (or .xpi)');
    
  } catch (error) {
    console.error('❌ Package creation failed:', error);
    process.exit(1);
  }
}

async function validateBuild(browser) {
  const buildDir = `dist/${browser}`;
  const manifestPath = path.join(buildDir, 'manifest.json');
  
  console.log(`🔍 Validating ${browser} build...`);
  
  try {
    // Check manifest exists and is valid JSON
    const manifest = await fs.readJson(manifestPath);
    
    // Check required files exist
    const requiredFiles = [
      'src/background/background.js',
      'src/content/content.js',
      'src/popup/popup.html',
      'src/popup/popup.js',
      'src/polyfill/browser-polyfill.min.js'
    ];
    
    for (const file of requiredFiles) {
      const filePath = path.join(buildDir, file);
      if (!await fs.pathExists(filePath)) {
        throw new Error(`Missing required file: ${file}`);
      }
    }
    
    // Browser-specific validation
    if (browser === 'chrome') {
      if (manifest.manifest_version !== 3) {
        throw new Error('Chrome build must use manifest version 3');
      }
      if (!manifest.background?.service_worker) {
        throw new Error('Chrome build must specify service_worker in background');
      }
    } else if (browser === 'firefox') {
      if (manifest.manifest_version !== 2) {
        throw new Error('Firefox build must use manifest version 2');
      }
      if (!manifest.background?.scripts) {
        throw new Error('Firefox build must specify scripts in background');
      }
    }
    
    console.log(`✅ ${browser} build validation passed`);
    return true;
    
  } catch (error) {
    console.error(`❌ ${browser} build validation failed:`, error.message);
    return false;
  }
}

async function validateAllBuilds() {
  console.log('🔍 Validating all builds...');
  
  const chromeValid = await validateBuild('chrome');
  const firefoxValid = await validateBuild('firefox');
  
  if (chromeValid && firefoxValid) {
    console.log('✅ All builds validated successfully');
    return true;
  } else {
    console.error('❌ Build validation failed');
    return false;
  }
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'chrome':
      buildForBrowser('chrome');
      break;
    case 'firefox':
      buildForBrowser('firefox');
      break;
    case 'validate':
      // Exit non-zero on failure, or the CI "Validate builds" step passes
      // whatever validateAllBuilds() reports.
      validateAllBuilds().then((ok) => {
        if (!ok) process.exit(1);
      });
      break;
    case 'package':
      buildAll().then(() => createPackages());
      break;
    default:
      buildAll();
  }
}

module.exports = { buildForBrowser, buildAll, createPackages, validateBuild, validateAllBuilds };