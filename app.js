const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const FormData = require('form-data');

const API_KEY = "80516fc41ba03824045c6c3feb7cd4ed";
const VOTE_URL = "https://www.xtremetop100.com/in.php?site=1132227942";
const PROXY_LIST_URL = "https://www.sslproxies.org/";

async function getProxies() {
    console.log("[+] Fetching free proxies...");
    try {
        const response = await axios.get(PROXY_LIST_URL);
        const $ = cheerio.load(response.data);
        let proxies = [];
        
        $('table tbody tr').each((index, element) => {
            const tds = $(element).find('td');
            if (tds.length > 1) {
                const ip = $(tds[0]).text().trim();
                const port = $(tds[1]).text().trim();
                proxies.push(`http://${ip}:${port}`);
            }
        });
        
        console.log(`[+] ${proxies.length} proxies found!`);
        return proxies;
    } catch (error) {
        console.error("[!] Failed to fetch proxy list:", error);
        return [];
    }
}

async function solveCaptcha(imageBuffer) {
    console.log("[+] Submitting CAPTCHA to 2Captcha...");
    try {
        const base64Image = Buffer.from(imageBuffer).toString('base64');
        const response = await axios.post("https://2captcha.com/in.php", {
            key: API_KEY,
            method: 'base64',
            body: base64Image,
            json: 1
        });
        
        if (response.data.status !== 1) {
            console.log("[!] CAPTCHA submission failed");
            return null;
        }
        const captchaId = response.data.request;
        
        await new Promise(resolve => setTimeout(resolve, 15000));
        
        for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            const result = await axios.get(`https://2captcha.com/res.php?key=${API_KEY}&action=get&id=${captchaId}&json=1`);
            if (result.data.status === 1) {
                console.log(`[+] CAPTCHA Solved: ${result.data.request}`);
                return result.data.request;
            }
        }
        console.log("[!] CAPTCHA solution timed out");
        return null;
    } catch (error) {
        console.error("[!] Error solving CAPTCHA:", error);
        return null;
    }
}

async function voteWithProxy(proxy) {
    console.log(`[+] Using proxy: ${proxy}`);
    try {
        const browser = await puppeteer.launch({
            headless: false,
            args: [
                `--proxy-server=${proxy}`,
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ]
        });
        const page = await browser.newPage();
        await page.goto(VOTE_URL);
        
        console.log("[+] Waiting for CAPTCHA...");
        const captchaElement = await page.waitForSelector('#captcha', { timeout: 15000 });
        const captchaBuffer = await captchaElement.screenshot();
        fs.writeFileSync('captcha.png', captchaBuffer);

        const captchaText = await solveCaptcha(captchaBuffer);
        if (!captchaText) {
            console.log("[!] CAPTCHA solving failed");
            await browser.close();
            return false;
        }

        await page.type('input[name="captcha_code"]', captchaText);
        // await page.waitForTimeout(2000);
        await new Promise(resolve => setTimeout(resolve, 2000));
        const voteButton = await page.waitForSelector('input[name="ticki"]');
        await voteButton.click();
        
        // Wait for navigation to the Turnstile challenge page
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 });
        
        console.log("[+] Looking for Turnstile challenge...");
        
        // Extract Turnstile site key
        const siteKey = await page.evaluate(() => {
            const turnstileElement = document.querySelector('iframe[src*="challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/"]');
            if (turnstileElement) {
                return turnstileElement.getAttribute('data-sitekey');
            }
            return null;
        });

        if (!siteKey) {
            console.log("[!] Could not find Turnstile site key");
            await browser.close();
            return false;
        }

        console.log("[+] Found Turnstile site key:", siteKey);
        console.log("[+] Solving Turnstile challenge...");

        // Solve Turnstile using 2captcha
        try {
            const pageUrl = page.url();
            const response = await axios.post('https://2captcha.com/in.php', {
                key: API_KEY,
                method: 'turnstile',
                sitekey: siteKey,
                pageurl: pageUrl,
                json: 1
            });

            if (response.data.status !== 1) {
                console.log("[!] Failed to submit Turnstile challenge");
                await browser.close();
                return false;
            }

            const captchaId = response.data.request;
            console.log("[+] Waiting for Turnstile solution...");
            
            // Wait initial delay
            await new Promise(resolve => setTimeout(resolve, 15000));

            // Poll for solution
            for (let i = 0; i < 12; i++) {
                const result = await axios.get(`https://2captcha.com/res.php?key=${API_KEY}&action=get&id=${captchaId}&json=1`);
                
                if (result.data.status === 1) {
                    const token = result.data.request;
                    console.log("[+] Got Turnstile token");

                    // Apply the token
                    await page.evaluate((token) => {
                        window.turnstileCallback(token);
                    }, token);

                    // Wait for verification
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    
                    // Check if verification was successful
                    const currentUrl = page.url();
                    if (currentUrl.includes('success') || await page.$('.success-message')) {
                        console.log("[+] Vote successful!");
                        await browser.close();
                        return true;
                    }
                    break;
                }
                
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        } catch (error) {
            console.error("[!] Error solving Turnstile:", error);
        }
        
        console.log("[!] Turnstile challenge failed or timed out");
        await browser.close();
        return false;
    } catch (error) {
        console.error("[!] Error voting with proxy:", error);
        return false;
    }
}

(async () => {
    const proxies = await getProxies();
    let voteCount = 0;

    for (const proxy of proxies) {
        const success = await voteWithProxy(proxy);
        if (success) {
            voteCount++;
            console.log(`✅ Total votes: ${voteCount}`);
        } else {
            console.log("❌ Trying next proxy...");
        }
        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (30000 - 10000) + 10000)));
    }

    console.log(`🎉 Finished! Successfully voted ${voteCount} times.`);
})();
