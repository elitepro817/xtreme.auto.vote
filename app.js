
const puppeteer = require("puppeteer");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs").promises;
const fss = require("fs");
const { Solver } = require("@2captcha/captcha-solver");

const API_KEY = "80516fc41ba03824045c6c3feb7cd4ed";
const VOTE_URL = "https://www.xtremetop100.com/in.php?site=1132376683";
const PROXY_LIST_URL = "https://www.sslproxies.org/";
// https://www.xtremetop100.com/in.php?site=1132376683
const solver = new Solver(API_KEY);

async function getProxies() {
  console.log("[+] Fetching free proxies...");
  try {
    const response = await axios.get(PROXY_LIST_URL);
    const $ = cheerio.load(response.data);
    let proxies = [];

    $("table tbody tr").each((index, element) => {
      const tds = $(element).find("td");
      if (tds.length > 1) {
        const ip = $(tds[0]).text().trim();
        const port = $(tds[1]).text().trim();
        proxies.push(`http://${ip}:${port}`);
      }
    });

    console.log(`[+] ${proxies.length} proxies found!`);
    return proxies;
  } catch (error) {
    console.error("[!] Failed to fetch proxy list:", error.message);
    return [];
  }
}
// const fs = require('fs').promises;
async function getProxies_from_txt() {
  try {
    const data = await fs.readFile('proxies.txt', { encoding: 'utf8' });     
    return data.split('\n').map(line => line.trim()).filter(line => line); // Process each line
  } catch (err) {
      console.error("Error reading proxies:", err);
      return [];
  }
}

async function solveCaptcha(imageBuffer) {
  console.log("[+] Submitting CAPTCHA to 2Captcha...");
  try {
    const base64Image = Buffer.from(imageBuffer).toString("base64");
    const response = await axios.post("https://2captcha.com/in.php", {
      key: API_KEY,
      method: "base64",
      body: base64Image,
      json: 1,
    });

    if (response.data.status !== 1) {
      console.log("[!] CAPTCHA submission failed");
      return null;
    }
    const captchaId = response.data.request;

    await new Promise((resolve) => setTimeout(resolve, 15000));

    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const result = await axios.get(
        `https://2captcha.com/res.php?key=${API_KEY}&action=get&id=${captchaId}&json=1`
      );
      if (result.data.status === 1) {
        console.log(`[+] CAPTCHA Solved: ${result.data.request}`);
        return result.data.request;
      }
    }
    console.log("[!] CAPTCHA solution timed out");
    return null;
  } catch (error) {
    console.error("[!] Error solving CAPTCHA:", error.message);
    return null;
  }
}

async function voteWithProxy(proxy, retryCount = 0) {
  console.log(`[+] Using proxy: ${proxy}`);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      executablePath:
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: [
        `--proxy-server=${proxy}`,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        `--user-data-dir=%userprofile%\\AppData\\Local\\Google\\Chrome\\User Data\\Default`,
        "--profile-directory=Default`,",
      ],
    });
    const page = await browser.newPage();

    // Set a longer timeout for navigation
    page.setDefaultNavigationTimeout(60000);

    await page.goto(VOTE_URL, { waitUntil: "networkidle0" });

    console.log("[+] Waiting for CAPTCHA...");
    const captchaElement = await page.waitForSelector("#captcha", {
      timeout: 30000,
    });
    const captchaBuffer = await captchaElement.screenshot();
    fss.writeFileSync("captcha.png", captchaBuffer);

    const captchaText = await solveCaptcha(captchaBuffer);
    if (!captchaText) {
      console.log("[!] CAPTCHA solving failed");
      return false;
    }

    await page.type('input[name="captcha_code"]', captchaText);
    // await page.waitForTimeout(2000);

    const voteButton = await page.waitForSelector('input[name="ticki"]');
    // await Promise.all([
    // page.waitForNavigation({ waitUntil: 'networkidle0' }),
    // ]);
    voteButton.click();

    console.log("[+] Vote submitted, handling Turnstile challenge...");
    // await new Promise((resolve) => setTimeout(resolve, 1000));
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    // Inject Turnstile interception code
    await page.evaluate(() => {
      console.clear = () => console.log("Console was cleared");
      const i = setInterval(() => {
        console.log("--1--");
        if (window.turnstile) {
          console.log("--2--");
          clearInterval(i);
          window.turnstile.render = (a, b) => {
            let params = {
              sitekey: b.sitekey,
              pageurl: window.location.href,
              data: b.cData,
              pagedata: b.chlPageData,
              action: b.action,
              userAgent: navigator.userAgent,
              json: 1,
            };
            console.log("intercepted-params:" + JSON.stringify(params));
            window.cfCallback = b.callback;
          };
        }
      }, 50);
    });

    // Handle Turnstile challenge with timeout
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log("[!] Turnstile challenge timed out");
        resolve(false);
      }, 60000);

      page.on("console", async (msg) => {
        const txt = msg.text();
        console.log("[+] Hello:", txt);
        if (txt.includes("intercepted-params:")) {
          const params = JSON.parse(txt.replace("intercepted-params:", ""));
          console.log("[+] Solving Turnstile challenge...");
          try {
            const res = await solver.cloudflareTurnstile(params);
            console.log(`[+] Solved Turnstile challenge ${res.id}`);
            await page.evaluate((token) => {
              window.cfCallback(token);
            }, res.data);
            await page.waitForNavigation({ waitUntil: "networkidle0" });
            console.log("[+] Vote successful!");
            clearTimeout(timeout);
            resolve(true);
          } catch (e) {
            console.error("[!] Error solving Turnstile challenge:", e.message);
            clearTimeout(timeout);
            resolve(false);
          } finally {
            browser.close();
          }
        }
      });
    });
  } catch (error) {
    console.error("[!] Error voting with proxy:", error.message);
    if (retryCount < 2) {
      console.log(`[+] Retrying vote (Attempt ${retryCount + 2})...`);
      return voteWithProxy(proxy, retryCount + 1);
    }
    return false;
  } finally {
    if (browser) {
      // await browser.close();
    }
  }
}

(async () => {
  const proxies = await getProxies_from_txt();
  let voteCount = 0;

  for (proxy of proxies) {
    proxy = 'http://' + proxy;
    const success = await voteWithProxy(proxy);
    if (success) {
      voteCount++;
      console.log(`✅ Total votes: ${voteCount}`);
    } else {
      console.log("❌ Voting failed, trying next proxy...");
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.floor(Math.random() * (30000 - 10000) + 10000))
    );
  }

  console.log(`🎉 Finished! Successfully voted ${voteCount} times.`);
})();
