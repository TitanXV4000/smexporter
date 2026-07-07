/* smexporter
Grabs an export of the SMAX Report in CSV format at a specified interval
Dynamic State-Machine Version (Persistent Browser Session)
*/

const puppeteer = require('puppeteer');
const tsanfordLogger = require('tsanford-logger');
const chokidar = require('chokidar');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

const logger = tsanfordLogger.newLogger();
logger.info("Starting up SMAX Exporter with Persistent Browser Session.");

// Configurations from Environment Variables
const config = {
    URL: process.env.SM_URL || 'https://us42-smax.saas.microfocus.com/reports/report/6a46933fe4b04be6b5d7ddda?TENANTID=731633586',
    DURATION: process.env.SM_DURATION || '2', 
    USER_LOGIN: process.env.USER_LOGIN || 'tsanford@opentext.com',
    PASS: process.env.PASS || 'Password',
    DOWNLOAD_PATH: process.env.DOWNLOAD_PATH || '/smexports',
    LOG_LEVEL: process.env.LOG_LEVEL || 'debug',
    REPORT_TAG: process.env.REPORT_TAG || 'open',
    REPORT_INTERVAL: parseInt(process.env.REPORT_INTERVAL || '60000', 10),
    DOWNLOAD_TIMEOUT: parseInt(process.env.DOWNLOAD_TIMEOUT || '120000', 10)
};

const tempDownloadPath = `${config.DOWNLOAD_PATH}/${config.REPORT_TAG}`;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeTempDir() {
    try {
        await fsPromises.mkdir(tempDownloadPath, { recursive: true });
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
    }
}

async function runExporterLifecycle() {
    await makeTempDir();

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1920,1080',
            '--disable-infobars'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Configure persistent download directory behavior
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: tempDownloadPath
    });

    logger.debug(`Initial navigation browser context to target URL: ${config.URL}`);
    await page.goto(config.URL, { waitUntil: 'networkidle2', timeout: 0 });

    let runCount = 0;

    // Endless execution cycle that keeps the same browser instance open
    while (true) {
        runCount++;
        logger.info(`--- Starting Extraction Loop Cycle #${runCount} ---`);
        let downloadTriggeredForThisCycle = false;
        let stateAttempts = 0;
        const maxStateAttempts = 20;

        // State Machine Evaluator
        while (!downloadTriggeredForThisCycle && stateAttempts < maxStateAttempts) {
            stateAttempts++;
            const currentUrl = page.url();
            logger.debug(`Evaluating State (Attempt ${stateAttempts}) | URL: ${currentUrl}`);
            
            // Save step screenshots sequentially by layout attempt inside the run cycle
            //await page.screenshot({ path: `/smexports/debug-run${runCount}-state${stateAttempts}.png`, fullPage: true }).catch(err => {});

            // -------------------------------------------------------------------------
            // STATE 1: Initial Identity Portal Gateway (Username Entry Screen)
            // -------------------------------------------------------------------------
            if (await page.$('#Ecom_User_ID') && await page.$('#loginButton2')) {
                logger.info("State Detected: Initial Identity Portal Gateway. Inputting username...");
                await page.type('#Ecom_User_ID', config.USER_LOGIN);
                await page.click('#loginButton2');
                await sleep(4000); 
                continue;
            }

            // -------------------------------------------------------------------------
            // STATE 2: Employee Sign-In Portal (Username + Password Form Screen)
            // -------------------------------------------------------------------------
            if (await page.$('input[name="Ecom_Password"]') || await page.$('#password')) {
                logger.info("State Detected: OpenText Employee Credential Challenge Form.");
                const userField = await page.$('#username') || await page.$('input[name="Ecom_User_ID"]');
                if (userField) {
                    await page.$eval('#username', el => el.value = '').catch(() => {});
                    await page.type('#username', config.USER_LOGIN).catch(() => {});
                }

                const passSelector = (await page.$('#password')) ? '#password' : 'input[name="Ecom_Password"]';
                await page.type(passSelector, config.PASS);
                
                logger.info("Submitting employee authentication challenge credentials...");
                const submitButton = await page.$('input[type="submit"]') || await page.$('#loginButton2');
                await submitButton.click();
                await sleep(6000); 
                continue;
            }

            // -------------------------------------------------------------------------
            // STATE 4: Target Report View Populated - Direct Export
            // -------------------------------------------------------------------------
            if (currentUrl.toLowerCase().includes('/reports/report/')) {
                logger.info("State Detected: Dedicated Report Module Active. Querying Export action...");

                // Find and click the top-level "Export CSV" action item directly on the toolbar
                const exportTriggered = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, [role="button"], .ess-btn, .btn'));
                    const targetBtn = buttons.find(b => {
                        const txt = (b.textContent || '').trim();
                        return txt === 'Export CSV' || txt.includes('Export to CSV');
                    });

                    if (targetBtn) {
                        targetBtn.click();
                        return true;
                    }
                    return false;
                });

                if (exportTriggered) {
                    logger.info("Direct 'Export CSV' button clicked successfully. Catching file stream...");
                    downloadTriggeredForThisCycle = true;
                    
                    // Allow Chrome 10 seconds to fully compile the stream and dump to disk volume
                    await sleep(10000);
                    break;
                } else {
                    logger.warn("On report page but the 'Export CSV' action button was not found yet.");
                    await sleep(2500); // Give the rendering engine extra space to frame the toolbar buttons
                    continue;
                }
            }

            // Transient State Fallback (Triggers if interface layers are loading between login cards)
            logger.debug("State Undetermined/Transient. Waiting for interface framework stability...");
            await sleep(2500);
        }

        // Give the file system time to capture and settle the download before refreshing
        await sleep(5000);
        if (process.env.RUN_ONCE === 'true') {
            logger.info("RUN_ONCE configuration flag detected. Shuts down browser contexts.");
            break;
        }

        // Execution Sleep Gap: Keep browser completely open, idling right here
        logger.info(`Cycle complete. Browser remaining active. Sleeping for interval gap: ${config.REPORT_INTERVAL}ms`);
        await sleep(config.REPORT_INTERVAL);

        // -------------------------------------------------------------------------
        // POST-INTERVAL REFRESH ACTION
        // -------------------------------------------------------------------------
        logger.info("Interval complete. Refreshing browser viewport cache for next run execution...");
        await page.reload({ waitUntil: 'networkidle2', timeout: 0 }).catch(err => logger.error(`Page reload error caught: ${err.message}`));
    }

    await browser.close();
    process.exit(0);
}

// File Watcher Component (Handles base folder export and subdirectory tracking)
async function initFileWatcher() {
    // Watch the subdirectory, ignoring temp streams and our static tracking file
    const watcher = chokidar.watch(tempDownloadPath, { 
        ignored: [/\\.crdownload$/g, /\\.tmp$/g, /_last\\.csv$/], 
        persistent: true 
    });
    
    watcher.on('add', async function(filePath) {
        // Safe check: ignore temp files or files already modified by this watcher
        const baseName = path.basename(filePath);
        if (filePath.endsWith('.crdownload') || filePath.endsWith('.tmp') || baseName.endsWith('_last.csv')) return;

        logger.info(`File download event intercepted in subdirectory: ${filePath}`);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        
        // UPDATED: Moved duration right after report tag and removed the "d"
        const finalName = `${config.REPORT_TAG}_${config.DURATION}_smax_report_${timestamp}.csv`;
        
        // Target paths
        const baseDestPath = path.join(config.DOWNLOAD_PATH, finalName);
        const baseStagePath = path.join(config.DOWNLOAD_PATH, `${finalName}.tmp`);
        const subDirLastPath = path.join(tempDownloadPath, `${config.REPORT_TAG}_last.csv`);

        try {
            // 1. Save the static tracking copy to the subdirectory
            logger.info(`Creating persistent tracking copy in subdirectory: ${subDirLastPath}`);
            await copyFile(filePath, subDirLastPath);

            // 2. Use the original moveFile logic to place it in the base folder
            // This safely generates a new inode so smreportparser sees it cleanly!
            logger.info(`Moving unique export file to base directory: ${baseDestPath}`);
            await moveFile(filePath, baseDestPath);

            logger.info(`File pipeline complete. Clean handoff ready in base volume: ${baseDestPath}`);
        } catch (err) {
            logger.error(`Failed renaming operations on targeted output path: ${err.message}`);
        }

    });
}

// Application Lifecycle Core Launcher
(async () => {
    await initFileWatcher();
    await runExporterLifecycle();
})();

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

