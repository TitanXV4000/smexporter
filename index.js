/* 
sfexporter
grabs an export of the specified report in csv format once per minute
jwalker
*/
var config = require('./config');
var reportCount = 0;
var refreshCount = -1;
const puppeteer = require('puppeteer');
const jwalkerLogger = require('tsanford-logger');
const chokidar = require('chokidar');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

const logger = jwalkerLogger.newLogger();
logger.info("Starting up.");

var sleepTime = Math.floor(config.REPORT_INTERVAL / 1000);
var sleepTimeUnit = "seconds";
if (sleepTime > 60 ) { sleepTime = Math.floor(sleepTime / 60); sleepTimeUnit = "minutes"; }
if (sleepTime > 60 ) { sleepTime = Math.floor(sleepTime / 60); sleepTimeUnit = "hours"; }

const tempDownloadPath = `${config.DOWNLOAD_PATH}/${config.REPORT_TAG}`;

//var downloading = false;
var downloadFinished = false;
var fileMoved = false;


(async () => {
  /* Create temp download directory */
  try {
    await makeTempDir();
  } catch (e) {
    logger.error(e);
    logger.error('Error unrecoverable. Exiting...');
    process.exit(5);
  }

  /* Create filesystem listener to watch download progress */
  const watcher = chokidar.watch(tempDownloadPath, {ignored: /\.csv$/g, persistent: true});
  watcher
    .on('add', function(filePath)  {
      logger.info('Download of file ' + filePath + ' has begun.');
    })
    //.on('change', function(filePath)  { logger.debug('File ' + filePath + ' has been changed.'); })
    .on('unlink', async function(filePath)  {
      let basename = path.basename(filePath, '.crdownload');
      logger.debug('File has finished downloading: ' + basename);
      downloadFinished = true;
      
      try {
        await copyFile(`${tempDownloadPath}/${basename}`,
                       `${tempDownloadPath}/${config.REPORT_TAG}_last.csv`);
      } catch (e) {
        logger.error(e);
      }

      try {
        await moveFile(`${tempDownloadPath}/${basename}`,
                       `${config.DOWNLOAD_PATH}/${config.REPORT_TAG}_${basename}`);
      } catch (e) {
        logger.error(e);
        process.exit(5);
      }
    })
    .on('error', function(error) { logger.error('Error happened: ' + error); });

  try {

  /* Initiate the Puppeteer browser */
  const browser = await puppeteer.launch({
    headless: true, // or false temporarily for visual debugging
    args: [
        '--no-sandbox', // Essential for Docker
        '--disable-setuid-sandbox', 
        '--single-process', 
        '--no-zygote',
        '--ignore-certificate-errors',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080' // NEW: Adds a standard screen size to bypas
    ],
    // ... other options
  });
  logger.info("Browser loaded.");

  const context = browser.defaultBrowserContext();
  context.overridePermissions(config.SF_URL, ["notifications"]);

  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(60000);
  logger.info("Blank page loaded.");

  /* Go to the page and wait for it to load */
  await page.goto(config.SF_URL, { waitUntil: 'networkidle2' });
  logger.info("Salesforce initial auth page loaded.");
  //await page.screenshot({ path: config.DOWNLOAD_PATH + "/1-sf-initial-auth.jpg" });

  /* Click on the SSO button */
  await Promise.all([
    await sleep(5000),
    await page.click('#idp_section_buttons > button > span'),
    await page.keyboard.press('Enter'),
    waitForNetworkIdle(page, 20000, 0),
    logger.info("Navigating to SSO page."),
  ]);
  //await page.screenshot({ path: config.DOWNLOAD_PATH + "/2a-navigate-to-sso.jpg" });

  /* Enter username/password (AI) */
  logger.info("Entering credentials and logging in to Salesforce.");
  await page.type('#username', config.USER_LOGIN);
  await page.type('#password', config.PASS);
  //await page.screenshot({ path: config.DOWNLOAD_PATH + "/2b-password-entered.jpg" });

  // Wait for the navigation to the next page after hitting Enter.
  //await Promise.all([
  //  page.keyboard.press('Enter'),
  //  page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }), // Increased timeout to 60s
  //  logger.info("Waiting for next page to load after login..."),
  //]);

  const navigationPromise = page.waitForNavigation({ 
    waitUntil: 'domcontentloaded', // Use domcontentloaded for faster detection
    timeout: 60000 
  });
  
  // Click the Login button found in mf-login.txt
  await page.click('input[name="submit"]');

  // 2. Wait for the navigation to resolve
  await navigationPromise;

  logger.info("2FA selection page loaded.");

  const frames = page.mainFrame().childFrames();
  if (frames.length > 0) {
    logger.warn(`Found ${frames.length} child frames. Content might be in an iframe.`);
    frames.forEach((frame, index) => {
      logger.warn(`Frame ${index + 1} URL: ${frame.url()}`);
    });
  } else {
    logger.info("No child frames found on the main page.");
  }

  await sleep(1000); 

  const currentUrl = page.url();
  logger.info(`Current URL after navigation: ${currentUrl}`);
  
  // Wait for the body content to ensure DOM is ready for snapshot
  // Using a long wait here to test for slow rendering
  try {
    await page.waitForSelector('body', { visible: true, timeout: 10000 }); 
  } catch (e) {
    logger.error("Body selector failed to become visible. Page is likely truly empty.");
    // Continue with content check anyway
  }

  const pageContent = await page.content();
  const contentSnippet = pageContent.substring(0, 500);
  logger.info(`Page content snippet (first 500 chars): ${contentSnippet}`);
  
  //await page.screenshot({ path: config.DOWNLOAD_PATH + "/3-2FA-selection.jpg" });



  /* Select 2FA TOTP and click enter */
  await Promise.all([
    await sleep(5000),
    /* await page.keyboard.press('Tab'), */
    await page.keyboard.press('ArrowDown'),
    await page.keyboard.press('Tab'),
    await page.keyboard.press('Enter'),
    waitForNetworkIdle(page, 2000, 0),
    //logger.info("Waiting for 2FA acceptance."),
    logger.info("2FA code page loaded"),
  ]);
  //await page.screenshot({ path: config.DOWNLOAD_PATH + "/4-2FA-code-page.jpg" });

  /* Read 2FA code */
  var code2FAnum = await readFile(config.DOWNLOAD_PATH + "/totp.txt");
  var code2FAarr = code2FAnum.toString().replace(/\r\n/g,'\n').split('\n');
  var code2FA = code2FAarr[0];

  /* Enter 2FA code and submit */
  await Promise.all([
    await sleep(5000),
    await page.type('#nffc', code2FA),
    /* await page.keyboard.press('Enter'), */
    await page.keyboard.press('Tab'),
    await page.keyboard.press('Space'),
    logger.info("2FA code entered: " + code2FA),
    waitForNetworkIdle(page, 20000, 0),
    //logger.info("Waiting for 2FA acceptance."),
  ]);
  //await page.screenshot({ path: config.DOWNLOAD_PATH + "/5-2FA-code-entered.jpg" });

  /* Enter 2FA code and submit */
  await Promise.all([
    await sleep(2000),
    await page.keyboard.press('Enter'),
    logger.info("2FA code submitted: " + code2FA),
    waitForNetworkIdle(page, 20000, 0),
    //logger.info("Waiting for 2FA acceptance."),
  ]);
  //await page.screenshot({ path: config.DOWNLOAD_PATH + "/6-2FA-code-submitted.jpg" });

  logger.info("Report page loaded."),

  /* Set download location */
  await page._client.send('Page.setDownloadBehavior', {behavior: 'allow', downloadPath: tempDownloadPath});

  /* Traverse the page with key presses to download the report */
  var finished = false;
  //try {
    // Click the "Export Details" button. Only needs to happen once.
    await page.evaluate(() => {
      document.querySelector("#report > div.bFilterReport > div.reportActions > input:nth-child(8)")
        .click();
    });
    logger.silly("Clicked \"Export Details\" button.");
    await sleep(5000);

    do {
      refreshCount++;
      if (refreshCount >= 1) {
        logger.info("Reloading page. Count=" + refreshCount);
        await page.reload();
        refreshCount = 0;
        logger.debug("Page reloaded. Count=" + refreshCount);
      }

      // Change report type to csv
      await pressKey(page, 'Tab', 4);
      await pressKey(page, 'ArrowUp');
      logger.silly("Pressed [TAB TAB ARROWUP] keys.");
      
      // Click the "Export" button to begin download. 
      // It seems to take around 20 seconds for the download to complete once the export button is clicked.
      await page.evaluate(() => {
        document.querySelector("#bottomButtonRow > input:nth-child(1)")
          .click();
      });
      logger.silly("Clicked \"Export\" button.");

      /* Verify file was downloaded */
      logger.debug("Waiting for download to start...");
      await waitForDownload(config.DOWNLOAD_TIMEOUT);

      logger.info("Sleeping for " + sleepTime + " " + sleepTimeUnit + "... Count=" + reportCount);
      await sleep (config.REPORT_INTERVAL);
    } while (!finished);
  } catch (err) {
    if (refreshCount >= 3) { finished = true; }
    //finished = true;
    logger.error("C=" + refreshCount + " F=" + finished + " Error caught during export procedure: " + err);
  } finally {
    try {
      if (browser !== null ) {
        await browser.close();
      }
      logger.info("Browser closed. Exiting.");
    } catch (err) {
      logger.error("Error caught during browser.close(): " + err);
    } finally {
      process.exit();
    }
  }
})();


/* Works with the chokidar watcher to wait for the file download to complete */
async function waitForDownload(timeout = 60000 /* ms */) {
  var complete = false;
  var elapsedTime = 0;
  do {
    if (downloadFinished && fileMoved) {
      logger.debug("File download completed and moved to non-temp directory.");
      downloadFinished = false;
      fileMoved = false;
      complete = true;
      reportCount++;
    } else {
      if (elapsedTime >= timeout) throw new Error("Download timeout reached.");
      logger.silly("Still waiting for download to complete. Time elapsed: " + elapsedTime / 1000 + " seconds.");
      elapsedTime += 1000;
      await sleep(1000);
    }
  } while (!complete);
}


/* Presses the key x times */
async function pressKey(page, key, presses = 1) {
  if (presses == 1) {
    await page.keyboard.press(key);
  } else {
    for (var i = 0; i < presses; i++) {
      await page.keyboard.press(key);
      await sleep(200);
    }
  }
}


async function makeTempDir() {
  try {
    await fsPromises.mkdir(tempDownloadPath);
  } catch (e) {
    if (e.errno != -17) throw e; // -17 file already exists
  }
}


async function moveFile(oldname, newname) {
  logger.debug(`Moving file ${oldname} to ${newname}`);
  try {
    await fsPromises.rename(oldname, newname);
    logger.debug('File move complete.');
    fileMoved = true;
  } catch (e) { 
    logger.error('Throwing error from moveFile()');
    throw e;
  }
}


async function copyFile(oldname, newname) {
  logger.debug(`Copying file ${oldname} to ${newname}`);
  try {
    await fsPromises.copyFile(oldname, newname);
    logger.debug('File copy complete.');
    fileCopied = true;
  } catch (e) { 
    logger.error('Throwing error from copyFile()');
    throw e;
  }
}

async function readFile(path) {
  try {
    return fs.readFileSync(path);
  } catch (e) {
    logger.error("Error caught in readFile: " + e.toLocaleString());
  }t
}

/* Use if 500ms timeout of 'networkidleX' is insufficient */
function waitForNetworkIdle(page, timeout, maxInflightRequests = 0) {
  page.on('request', onRequestStarted);
  page.on('requestfinished', onRequestFinished);
  page.on('requestfailed', onRequestFinished);

  let inflight = 0;
  let fulfill;
  let promise = new Promise(x => fulfill = x);
  let timeoutId = setTimeout(onTimeoutDone, timeout);
  return promise;

  function onTimeoutDone() {
    page.removeListener('request', onRequestStarted);
    page.removeListener('requestfinished', onRequestFinished);
    page.removeListener('requestfailed', onRequestFinished);
    fulfill();
  }

  function onRequestStarted() {
    ++inflight;
    if (inflight > maxInflightRequests)
      clearTimeout(timeoutId);
  }
  
  function onRequestFinished() {
    if (inflight === 0)
      return;
    --inflight;
    if (inflight === maxInflightRequests)
      timeoutId = setTimeout(onTimeoutDone, timeout);
  }
}


/* They promised me this would not be needed... */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
} 
