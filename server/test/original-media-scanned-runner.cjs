"use strict";
const path=require("node:path");
const os=require("node:os");
const scanRoot=path.join(os.homedir(),".cache/knowladder-clamav-104");
process.env.TEST_CLAMSCAN_PATH=path.join(scanRoot,"engine/clamav-1.5.4.win.x64/clamscan.exe");
process.env.TEST_CLAMAV_DATABASE=path.join(scanRoot,"database");
process.env.CVD_CERTS_DIR=path.join(scanRoot,"engine/clamav-1.5.4.win.x64/certs");
process.env.SCAN_DATABASE_MAX_AGE_HOURS="168";
require("./training-supplement-runner.cjs");
