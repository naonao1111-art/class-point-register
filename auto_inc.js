// auto_inc.js - 自动补分核心逻辑
// 在每个页面加载时调用 checkAndRunAutoIncrement()
// 使用 localStorage 记录当日是否已执行，避免重复
(async function() {
    const REPO_OWNER = "naonao1111-art";
    const REPO_NAME = "class-point-register";
    const DATA_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/data.json`;
    const REASONS_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/reasons.json`;
    const RATINGS_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/committee_ratings.json`;
    const AUTO_TRACK_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/auto_increment_tracker.json`;
    const CONFIG_URL = "https://naonao1111-art.github.io/class-point-register/config_encoded.json";

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

    // ---------- 核心补分函数 ----------
    async function checkAndRunAutoIncrement() {
        // 1. 加载配置获取 token
        await loadConfig();
        if (!githubToken) {
            console.warn("未获取到 GitHub Token，跳过自动补分");
            return;
        }

        // 2. 检查今日是否已执行（使用 localStorage）
        const todayStr = getBeijingDateStr();
        const lastRun = localStorage.getItem('autoIncLastRun');
        if (lastRun === todayStr) {
            console.log("今日补分已执行，跳过");
            return;
        }

        // 3. 加载数据
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

        // ---- 4. 低分持续补分（按应补总天数一次性补足） ----
        for (let student of students) {
            if (student.score < -50) {
                let info = tracker.lowScoreStudents[student.id];
                if (!info) continue;
                // 检查是否单独禁用
                if (info.enabled === false) continue;
                // 检查开始日期是否已到
                if (todayDate < info.startDate) continue;
                // 计算从 startDate 到 todayDate 的总天数（按日期差）
                const start = new Date(info.startDate + 'T00:00:00+08:00');
                const today = new Date(todayDate + 'T00:00:00+08:00');
                const diffDays = Math.floor((today - start) / (24*60*60*1000)) + 1; // 包含开始日
                const totalDaysNeeded = Math.min(7, diffDays);
                const alreadyDone = info.daysAdded || 0;
                const toAdd = Math.max(0, totalDaysNeeded - alreadyDone);
                if (toAdd > 0) {
                    const delta = 2 * toAdd;
                    student.score += delta;
                    student.score = parseFloat(student.score.toFixed(2));
                    updates.push({
                        studentId: student.id,
                        studentName: student.name,
                        delta: delta,
                        reason: `低分持续补分（补${toAdd}天，已补${alreadyDone+toAdd}天）`
                    });
                    info.daysAdded = alreadyDone + toAdd;
                }
            }
        }

        // ---- 5. 周日奖励（按周防重复） ----
        if (getBeijingWeekday(beijingNow) === 0) {
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
                    for (let sid of participants) {
                        const student = students.find(s => s.id === sid);
                        if (student) {
                            const delta = 0.5;
                            student.score += delta;
                            student.score = parseFloat(student.score.toFixed(2));
                            updates.push({
                                studentId: student.id,
                                studentName: student.name,
                                delta: delta,
                                reason: "周日评价奖励"
                            });
                        }
                    }
                }
                tracker.lastBonusWeek = currentWeek; // 标记本周已奖励
            }
        }

        // ---- 6. 保存更新 ----
        if (updates.length > 0) {
            try {
                // 保存学生积分
                await saveJSON(DATA_URL, { students: students }, "自动补分更新积分");
                // 保存原因
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
                // 保存 tracker
                await saveJSON(AUTO_TRACK_URL, tracker, "更新补分追踪");
                console.log(`自动补分完成，共 ${updates.length} 名学生获得调整`);
            } catch(err) {
                console.error("保存补分数据失败", err);
            }
        } else {
            // 即使无更新，也保存 tracker（更新最后执行日期）
            await saveJSON(AUTO_TRACK_URL, tracker, "无补分更新");
        }

        // 7. 记录今日已执行
        localStorage.setItem('autoIncLastRun', todayStr);
    }

    // 暴露全局函数供页面调用
    window.checkAndRunAutoIncrement = checkAndRunAutoIncrement;
})();
