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
        headless: false,
        //executablePath: '/usr/bin/chromium-browser', 
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1920,1080'
            //'--no-sandbox', // Essential for Docker
            //'--disable-setuid-sandbox',
            //'--single-process',
            //'--no-zygote',
            //'--ignore-certificate-errors',
            //'--disable-features=IsolateOrigins,site-per-process',
            //'--window-size=1920,1080' // NEW: Adds a standard screen size to bypas

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
            await page.screenshot({ path: `/smexports/debug-state${runCount}.png`, fullPage: true }).catch(err => {});

            // -------------------------------------------------------------------------
            // STATE 1: Initial Identity Portal Gateway (Username Entry Screen)
            // -------------------------------------------------------------------------
            if (await page.$('#Ecom_User_ID') && await page.$('#loginButton2')) {
                logger.info("State Detected: Initial Identity Portal Gateway. Inputting username...");
                await page.type('#Ecom_User_ID', config.USER_LOGIN);
                await page.click('#loginButton2');
                await sleep(4000); 
                //await page.screenshot({ path: '/smexports/debug-state1.png', fullPage: true }).catch(err => {});
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
                //await page.screenshot({ path: '/smexports/debug-state2.png', fullPage: true }).catch(err => {});
                continue;
            }

            // -------------------------------------------------------------------------
            // STATE 3: SMAX Core Loaded - Searching/Navigating to QMON View
            // -------------------------------------------------------------------------
            const qmonSelector = '[data-m-id*="QMON"], [title*="QMON"], .sm-sidebar-item'; 
            if (currentUrl.includes('/saw/') && await page.$(qmonSelector)) {
                
                // Check if QMON is already selected/active on the screen
                const isQmonAlreadyActive = await page.evaluate(() => {
                    const activeFilter = document.querySelector('.ess-filter-favorite-item-selected');
                    if (activeFilter && activeFilter.textContent.includes('QMON')) return true;
                    
                    const activeElements = Array.from(document.querySelectorAll('.active, .selected'));
                    return activeElements.some(el => (el.textContent || '').trim() === 'QMON');
                });

                if (!isQmonAlreadyActive) {
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
                        //await page.screenshot({ path: '/smexports/debug-click.png', fullPage: true }).catch(err => {});
                        continue;
                    }
                } else {
                    logger.debug("QMON view is already selected. Skipping click sequence.");
                }
            }
            //await page.screenshot({ path: '/smexports/debug-state3.png', fullPage: true }).catch(err => {});

            // -------------------------------------------------------------------------
            // STATE 4: Target Grid Populated - Ready for CSV Export Interaction
            // -------------------------------------------------------------------------
            if (currentUrl.toLowerCase().includes('/saw/requests')) {
                
                // 1. Verify the "More" button is visually active and click it
                const moreBtnStatus = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, .ess-btn, .grid-header-button'));
                    const target = buttons.find(b => (b.textContent || '').trim() === 'More');
                    
                    if (target) {
                        const styles = window.getComputedStyle(target);
                        if (parseFloat(styles.opacity) < 0.8 || styles.pointerEvents === 'none' || target.hasAttribute('disabled')) {
                            return 'DISABLED'; 
                        }
                        target.click();
                        return 'CLICKED';
                    }
                    return 'NOT_FOUND';
                });

                if (moreBtnStatus === 'CLICKED') {
                    logger.info("State Detected: Active QMON Report Grid Ready. Action menu expanded.");
                    
                    // 2. Pause to allow the framework to render the dropdown overlay container
                    await sleep(2000);

                    // 3. Arrow down through the list until the "Export to CSV" row is highlighted
                    let csvHighlighted = false;
                    let navAttempts = 0;
                    const maxNavAttempts = 10;

                    while (!csvHighlighted && navAttempts < maxNavAttempts) {
                        navAttempts++;
                        logger.debug(`Keyboard Navigation: Sending ArrowDown stroke (Attempt ${navAttempts})...`);
                        await page.keyboard.press('ArrowDown');
                        await sleep(400); // Small pause for the focus style to render

                        // Check the active/focused DOM element text
                        csvHighlighted = await page.evaluate(() => {
                            const activeEl = document.activeElement;
                            if (!activeEl) return false;

                            // Check active element text, or look for sub-spans inside the active menu container
                            const elementText = (activeEl.textContent || '').trim();
                            
                            // SMAX often drops focus onto a container or list item wrapper
                            const hasExportText = elementText.toLowerCase().includes('export to csv') || elementText === 'CSV';
                            
                            // Double-check if the active element has a native 'focused' or 'active' menu class
                            const isFocusedMenuRow = activeEl.classList.contains('x-menu-item-active') || 
                                                     activeEl.classList.contains('focused') || 
                                                     !!activeEl.querySelector('.focused, .x-menu-item-active');

                            return hasExportText;
                        });
                    }

                    if (csvHighlighted) {
                        logger.info("Export to CSV option successfully highlighted! Pressing Enter key...");
                        await page.keyboard.press('Enter');
                        
                        logger.info("Enter key sent. Waiting for file generation stream...");
                        downloadTriggeredForThisCycle = true;
                        
                        // 4. Sleep to let Chrome complete the file stream write before breaking the cycle
                        await sleep(10000);
                        break;
                    } else {
                        logger.warn("Cycled through ArrowDown navigation steps but 'Export to CSV' highlight state was never captured.");
                        await page.screenshot({ path: `/smexports/debug-menu-failed-state${stateAttempts}.png`, fullPage: true }).catch(() => {});
                    }
                } else if (moreBtnStatus === 'DISABLED') {
                    logger.debug("Found 'More' button, but it is visually faded/disabled by SMAX. Waiting for grid stability...");
                }
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
        await page.reload({ waitUntil: 'networkidle2', timeout: 0 }).catch(err => logger.error(`Page reload error caught: ${err.message}`));
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
