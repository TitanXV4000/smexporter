/* smexporter
Grabs an export of the SMAX QMON view in CSV format at a specified interval
Dynamic State-Machine Version (Persistent Browser Session)
*/

const puppeteer = require('puppeteer');
const jwalkerLogger = require('tsanford-logger');
const chokidar = require('chokidar');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

const logger = jwalkerLogger.newLogger();
logger.info("Starting up SMAX Exporter with Persistent Browser Session.");

// Configurations from Environment Variables
const config = {
    URL: process.env.SM_URL || 'https://us42-smax.saas.microfocus.com/saw/Requests?TENANTID=731633586',
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
        // executablePath: '/usr/bin/chromium-browser', 
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1920,1080'
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
    await page.goto(config.URL, { waitUntil: 'Infinity' });

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
            // STATE 3: SMAX Core Loaded - Searching/Navigating to QMON View
            // -------------------------------------------------------------------------
            const qmonSelector = '[data-m-id*="QMON"], [title*="QMON"], .sm-sidebar-item'; 
            if (currentUrl.includes('/saw/') && await page.$(qmonSelector)) {
                logger.info("State Detected: SMAX Core Layout Active. Attempting QMON View click...");
                
                const targetClicked = await page.evaluate(() => {
                    const elements = Array.from(document.querySelectorAll('.sm-sidebar-item, [role="treeitem"], span, a'));
                    const qmonNode = elements.find(el => el.textContent && el.textContent.includes('QMON'));
                    if (qmonNode) {
                        qmonNode.click();
                        return true;
                    }
                    return false;
                });

                if (targetClicked) {
                    logger.info("Successfully targeted the QMON UI view element. Awaiting grid assembly...");
                    await sleep(6000); 
                }
                continue;
            }

            // -------------------------------------------------------------------------
            // STATE 4: Target Grid Populated - Ready for CSV Export Interaction
            // -------------------------------------------------------------------------
            const exportSelector = 'button[title*="CSV"], button[title*="Export"], .grid-export-btn, [data-action*="export"]';
            if (currentUrl.includes('/saw/Requests') && await page.$(exportSelector)) {
                logger.info("State Detected: Active QMON Report Grid Visible. Triggering CSV download stream...");
                
                await page.click(exportSelector);
                logger.info("Export button successfully clicked.");
                
                downloadTriggeredForThisCycle = true; 
                break;
            }

            // Transient State Fallback
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
        // This drops us back to State 3 or 4 instantly without losing session cookies!
        // -------------------------------------------------------------------------
        logger.info("Interval complete. Refreshing browser viewport cache for next run execution...");
        await page.reload({ waitUntil: 'Infinity' }).catch(err => logger.error(`Page reload error caught: ${err.message}`));
    }

    await browser.close();
    process.exit(0);
}

// File Watcher Component (Renames file instantly to capture the dynamic SM_DURATION property)
async function initFileWatcher() {
    const watcher = chokidar.watch(tempDownloadPath, { ignored: /\\.csv$/g, persistent: true });
    
    watcher.on('add', async function(filePath) {
        if (filePath.endsWith('.crdownload') || filePath.endsWith('.tmp')) return;

        logger.info(`File download event intercepted: ${filePath}`);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const finalName = `smax_report_${config.DURATION}d_${config.REPORT_TAG}_${timestamp}.csv`;
        const destPath = path.join(config.DOWNLOAD_PATH, finalName);

        try {
            logger.info(`Preserving copy file stream directly to target volume: ${destPath}`);
            await fsPromises.copyFile(filePath, destPath);
            await fsPromises.unlink(filePath); 
            logger.info("File system rename operations executed cleanly.");
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
