// auto_inc.js - 自动补分核心逻辑
// 在每个页面加载时调用 checkAndRunAutoIncrement()
// 使用 localStorage 记录当日是否已执行，避免重复
// 规则配置：protection_rules.json（低分保护参数 + 投票加分参数，可在“自动控制中心”页面编辑）
(async function() {
    const REPO_OWNER = "naonao1111-art";
    const REPO_NAME = "class-point-register";
    const DATA_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/data.json`;
    const REASONS_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/reasons.json`;
    const RATINGS_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/committee_ratings.json`;
    const AUTO_TRACK_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/auto_increment_tracker.json`;
    const CONFIG_URL = "https://naonao1111-art.github.io/class-point-register/config_encoded.json";
    const RULES_CONFIG_URL = "https://naonao1111-art.github.io/class-point-register/protection_rules.json";

    // ---------- 规则配置（低分保护 + 投票加分）----------
    let rulesConfig = {
        lowScoreProtect: {
            threshold: -50,    // 低于此分进入低分补分
            perDay: 2,         // 每天补分分值
            maxDays: 7,        // 最多补分天数
            T1: -30, T2: -38, T3: -45,
            upRatio1: 1.1, upRatio2: 1.2, upRatio3: 1.35,
            downRatio1: 1.12, downRatio2: 1.25, downRatio3: 1.5
        },
        voteBonus: {
            enabled: true,     // 是否启用周日评价奖励
            bonus: 0.5,        // 每位参与评价的同学奖励分值
            weights: { verygood: 1, good: 0.5, justsoso: 0, littlebad: -0.5, bad: -1 }
        }
    };

    // ---------- 工具函数 ----------
    function decodeToken(obfuscated) {
        if (!obfuscated) return "";
        const reversed = obfuscated.split('').reverse().join('');
        const shifted = atob(reversed);
        return shifted.split('').map(c => String.fromCharCode(c.charCodeAt(0) - 1)).join('');
    }

    function base64DecodeToUtf8(base64Str) {
        const binaryStr = atob(base64Str);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
    }

    function utf8ToBase64(str) {
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        let binary = '';
        for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
        return btoa(binary);
    }

    function formatBeijingTime(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const h = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        const s = String(d.getSeconds()).padStart(2, '0');
        return `${y}-${m}-${day} ${h}:${min}:${s}`;
    }

    function getBeijingNow() {
        const now = new Date();
        const utc = now.getTime() + now.getTimezoneOffset() * 60000;
        return new Date(utc + 8 * 3600000);
    }

    function getBeijingDateStr(d) {
        d = d || getBeijingNow();
        return d.toISOString().slice(0,10);
    }

    function getBeijingWeekday(d) {
        d = d || getBeijingNow();
        return d.getDay(); // 0=周日
    }

    function getWeekNumber(d) {
        d = new Date(d);
        d.setHours(0,0,0,0);
        const day = d.getDay() || 7;
        const diff = day - 1;
        const monday = new Date(d);
        monday.setDate(d.getDate() - diff);
        const startOfYear = new Date(monday.getFullYear(), 0, 1);
        const days = Math.floor((monday - startOfYear) / (24*60*60*1000));
        const weekNumber = Math.ceil((days + 1) / 7);
        return monday.getFullYear() + "-W" + String(weekNumber).padStart(2, '0');
    }

    // ---------- 网络请求 ----------
    let githubToken = "";

    async function loadConfig() {
        try {
            const resp = await fetch(CONFIG_URL + "?t=" + Date.now(), { cache: "no-store" });
            if (resp.ok) {
                const config = await resp.json();
                githubToken = decodeToken(config.github_token_obfuscated || "");
            }
        } catch(e) { console.error("加载配置失败", e); }
    }

    async function loadRulesConfig() {
        try {
            const resp = await fetch(RULES_CONFIG_URL + "?t=" + Date.now(), { cache: "no-store" });
            if (resp.ok) {
                const cfg = await resp.json();
                // 与默认值合并，缺字段时用默认值
                const lp = cfg.lowScoreProtect || {};
                const vb = cfg.voteBonus || {};
                if (typeof lp.threshold === 'number') rulesConfig.lowScoreProtect.threshold = lp.threshold;
                if (typeof lp.perDay === 'number') rulesConfig.lowScoreProtect.perDay = lp.perDay;
                if (typeof lp.maxDays === 'number') rulesConfig.lowScoreProtect.maxDays = lp.maxDays;
                if (typeof lp.T1 === 'number') rulesConfig.lowScoreProtect.T1 = lp.T1;
                if (typeof lp.T2 === 'number') rulesConfig.lowScoreProtect.T2 = lp.T2;
                if (typeof lp.T3 === 'number') rulesConfig.lowScoreProtect.T3 = lp.T3;
                if (typeof lp.upRatio1 === 'number') rulesConfig.lowScoreProtect.upRatio1 = lp.upRatio1;
                if (typeof lp.upRatio2 === 'number') rulesConfig.lowScoreProtect.upRatio2 = lp.upRatio2;
                if (typeof lp.upRatio3 === 'number') rulesConfig.lowScoreProtect.upRatio3 = lp.upRatio3;
                if (typeof lp.downRatio1 === 'number') rulesConfig.lowScoreProtect.downRatio1 = lp.downRatio1;
                if (typeof lp.downRatio2 === 'number') rulesConfig.lowScoreProtect.downRatio2 = lp.downRatio2;
                if (typeof lp.downRatio3 === 'number') rulesConfig.lowScoreProtect.downRatio3 = lp.downRatio3;
                if (typeof vb.enabled === 'boolean') rulesConfig.voteBonus.enabled = vb.enabled;
                if (typeof vb.bonus === 'number') rulesConfig.voteBonus.bonus = vb.bonus;
                if (vb.weights) Object.assign(rulesConfig.voteBonus.weights, vb.weights);
            }
        } catch(e) { console.warn("加载规则配置失败，使用默认值", e); }
    }

    async function fetchJSON(url) {
        const headers = githubToken ? { Authorization: `token ${githubToken}` } : {};
        const resp = await fetch(url, { headers, cache: 'no-store' });
        if (resp.status === 404) return null;
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        return JSON.parse(base64DecodeToUtf8(data.content));
    }

    async function saveJSON(url, content, message) {
        let sha = null;
        try {
            const res = await fetch(url, { headers: { Authorization: `token ${githubToken}` } });
            if (res.ok) sha = (await res.json()).sha;
        } catch(e) {}
        const payload = {
            message: message,
            content: utf8ToBase64(JSON.stringify(content, null, 2)),
            sha: sha
        };
        const resp = await fetch(url, {
            method: "PUT",
            headers: { Authorization: `token ${githubToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) throw new Error("保存失败");
    }

    // ---------- 并发锁（防止多个页面/标签页同时执行补分）----------
    const LOCK_KEY = 'autoIncRunningLock';
    const LOCK_TIMEOUT = 2 * 60 * 1000; // 2分钟内视为已有页面在执行

    function acquireLock() {
        try {
            const now = Date.now();
            const raw = localStorage.getItem(LOCK_KEY);
            if (raw) {
                try {
                    const info = JSON.parse(raw);
                    if (info && typeof info.time === 'number' && (now - info.time) < LOCK_TIMEOUT) {
                        return false; // 已有执行正在进行
                    }
                } catch(e) {}
            }
            localStorage.setItem(LOCK_KEY, JSON.stringify({ time: now }));
            return true;
        } catch(e) { return true; } // localStorage 不可用时放行
    }

    function releaseLock() {
        try { localStorage.removeItem(LOCK_KEY); } catch(e) {}
    }

    // ---------- 核心补分函数 ----------
    // force = true 时忽略“今日已执行”标记，强制再执行一次（供控制页“立即执行”按钮使用）
    async function checkAndRunAutoIncrement(force = false) {
        // 1. 加载配置获取 token 与规则
        await loadConfig();
        if (!githubToken) {
            console.warn("未获取到 GitHub Token，跳过自动补分");
            return;
        }
        await loadRulesConfig();

        // 2. 检查今日是否已执行（使用 localStorage）；force 时跳过此检查
        const todayStr = getBeijingDateStr();
        if (!force) {
            const lastRun = localStorage.getItem('autoIncLastRun');
            if (lastRun === todayStr) {
                console.log("今日补分已执行，跳过");
                return;
            }
        }

        // 3. 并发锁：同一时刻只允许一个页面执行补分
        if (!acquireLock()) {
            console.log("已有页面正在执行补分，本次跳过");
            return;
        }

        try {
            // 4. 加载数据
            let students = [];
            let reasons = [];
            let tracker = { stopped: false, lowScoreStudents: {}, lastSundayBonus: 0 };
            try {
                const data = await fetchJSON(DATA_URL);
                if (data && data.students) students = data.students.map(s => ({ ...s, score: parseFloat(s.score) }));
                const reasonsData = await fetchJSON(REASONS_URL);
                if (reasonsData) reasons = reasonsData;
                const trackerData = await fetchJSON(AUTO_TRACK_URL);
                if (trackerData) tracker = trackerData;
                if (!tracker.lowScoreStudents) tracker.lowScoreStudents = {};
                if (typeof tracker.stopped === 'undefined') tracker.stopped = false;
            } catch(e) {
                console.error("加载数据失败", e);
                return;
            }

            if (tracker.stopped) {
                console.log("自动补分已停止，跳过");
                localStorage.setItem('autoIncLastRun', todayStr);
                return;
            }

            const beijingNow = getBeijingNow();
            const todayDate = getBeijingDateStr(beijingNow);
            const updates = [];

            const lp = rulesConfig.lowScoreProtect;

            // ---- 5. 低分持续补分（每天最多补一次，每次 +perDay，最多 maxDays 天）----
            // 修复：停用期间不再累计天数；每次执行只补一天，防止一次补足多天导致分数暴涨
            for (let student of students) {
                if (student.score < lp.threshold) {
                    let info = tracker.lowScoreStudents[student.id];
                    if (!info) continue;
                    // 检查是否单独禁用
                    if (info.enabled === false) continue;
                    // 检查开始日期是否已到
                    if (todayDate < info.startDate) continue;
                    const done = info.daysAdded || 0;
                    if (done >= lp.maxDays) continue;
                    // 今天已经补过（防同一页面/多个页面同日重复执行）
                    if (info.lastAddDate === todayDate) continue;

                    const delta = lp.perDay;
                    student.score += delta;
                    student.score = parseFloat(student.score.toFixed(2));
                    updates.push({
                        studentId: student.id,
                        studentName: student.name,
                        delta: delta,
                        reason: `低分持续补分（第${done + 1}天，共${lp.maxDays}天）`
                    });
                    info.daysAdded = done + 1;
                    info.lastAddDate = todayDate; // 记录今天已补，同日不再重复
                }
            }

            // ---- 6. 周日投票奖励（按周防重复；是否启用与分值由配置控制）----
            if (getBeijingWeekday(beijingNow) === 0 && rulesConfig.voteBonus.enabled) {
                const currentWeek = getWeekNumber(beijingNow);
                if (tracker.lastBonusWeek !== currentWeek) {
                    let ratings = {};
                    try {
                        const ratingsData = await fetchJSON(RATINGS_URL);
                        if (ratingsData && ratingsData.ratings) ratings = ratingsData.ratings;
                    } catch(e) { console.warn("获取评价数据失败", e); }
                    const weekRatings = ratings[currentWeek] || {};
                    const participants = Object.keys(weekRatings);
                    if (participants.length > 0) {
                        const bonus = parseFloat(rulesConfig.voteBonus.bonus) || 0;
                        if (bonus > 0) {
                            for (let sid of participants) {
                                const student = students.find(s => s.id === sid);
                                if (student) {
                                    student.score += bonus;
                                    student.score = parseFloat(student.score.toFixed(2));
                                    updates.push({
                                        studentId: student.id,
                                        studentName: student.name,
                                        delta: bonus,
                                        reason: "周日评价奖励"
                                    });
                                }
                            }
                        }
                    }
                    tracker.lastBonusWeek = currentWeek; // 标记本周已奖励
                }
            }

            // ---- 7. 保存更新 ----
            if (updates.length > 0) {
                try {
                    // 先保存积分与 tracker（防止重复补分），再保存原因记录
                    await saveJSON(DATA_URL, { students: students }, "自动补分更新积分");
                    await saveJSON(AUTO_TRACK_URL, tracker, "更新补分追踪");
                    const timestamp = formatBeijingTime(beijingNow);
                    for (let u of updates) {
                        reasons.push({
                            timestamp: timestamp,
                            studentId: u.studentId,
                            studentName: u.studentName,
                            delta: u.delta,
                            reason: u.reason
                        });
                    }
                    await saveJSON(REASONS_URL, reasons, "自动补分记录原因");
                    console.log(`自动补分完成，共 ${updates.length} 名学生获得调整`);
                } catch(err) {
                    console.error("保存补分数据失败", err);
                    return; // 保存失败：不标记今日已执行，下次打开页面会重试
                }
            }

            // 8. 记录今日已执行（仅成功执行或成功跳过时标记）
            localStorage.setItem('autoIncLastRun', todayStr);
        } finally {
            releaseLock();
        }
    }

    // 暴露全局函数供页面调用
    window.checkAndRunAutoIncrement = checkAndRunAutoIncrement;
})();
