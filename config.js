exports.SM_URL = process.env.SM_URL || 'https://us42-smax.saas.microfocus.com/saw/Requests?TENANTID=731633586';
exports.SM_DURATION = process.env.SM_DURATION || '2'; // Number of days for the report
exports.USER_LOGIN = process.env.USER_LOGIN || '';
exports.PASS = process.env.PASS || '';
exports.DOWNLOAD_PATH = process.env.DOWNLOAD_PATH || '/smexports'; // Adjusted to match your new volume name
exports.DOWNLOAD_TIMEOUT = process.env.DOWNLOAD_TIMEOUT || '120000';
exports.NODE_ENV = process.env.NODE_ENV || 'dev';
exports.LOG_LEVEL = process.env.LOG_LEVEL || 'info';
exports.SERVICE_NAME = process.env.SERVICE_NAME || 'smexporter';
exports.TIMEZONE = process.env.TIMEZONE || 'America/Denver';
exports.REPORT_INTERVAL = process.env.REPORT_INTERVAL || '60000'; // ms (Updated to your preferred 60000)
exports.REPORT_TAG = process.env.REPORT_TAG || 'open'; // Designates the collection namespace
