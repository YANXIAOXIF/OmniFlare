/**
 * Project: OmniFlare Ultra
 * Version: 1.7.3-Radar (2025-12-20)
 * Theme: Aurora Glass
 * Feature: Radar UI, Real Stats, Whitelist
 */

const Config = {
    // 进度条目标值：达到多少次请求显示为 100%
    PROGRESS_GOAL: 500,
    // 伪装成不同的浏览器
    UA_POOL: [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    ],
    // 图床/资源白名单（这些域名不走代理，直接直连）
    DIRECT_HOSTS: [
        'images.weserv.nl', 'wsrv.nl', 'imgur.com', 'twimg.com', 'sinaimg.cn', 'baidu.com'
    ],
    DEFAULT_STATS: () => {
        return { docker: 0, dockerRaw: 0, github: 0, githubRaw: 0, total: 0, real: false };
    }
};

// 客户端 Hook 脚本
const INJECT_SCRIPT = `
<script>
(function() {
    const workerOrigin = window.location.origin;
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;

    window.fetch = function(input, init) {
        let newUrl = input;
        if (typeof input === 'string' && !input.startsWith(workerOrigin) && input.startsWith('http')) {
            newUrl = workerOrigin + '/' + input;
        }
        return originalFetch(newUrl, init);
    };

    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        let newUrl = url;
        if (typeof url === 'string' && !url.startsWith(workerOrigin) && url.startsWith('http')) {
            newUrl = workerOrigin + '/' + url;
        }
        return originalOpen.call(this, method, newUrl, ...args);
    };

    window.addEventListener('load', () => {
        setTimeout(() => {
            const keywords = ['继续访问', 'continue', 'redirect', '跳转', '进入'];
            const links = document.getElementsByTagName('a');
            for(let a of links) {
                if(keywords.some(k => a.innerText.toLowerCase().includes(k)) || a.id === 'click-to-continue') {
                    console.log('OmniFlare: Auto-clicking redirect link', a.href);
                    a.click();
                    break;
                }
            }
        }, 800);
    });
})();
</script>
`;

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        const queryUrl = url.searchParams.get('url') || url.searchParams.get('q');
        if ((url.pathname === "/" || url.pathname === "") && queryUrl) {
            const target = queryUrl.startsWith('http') ? queryUrl : 'https://' + queryUrl;
            return this.processProxy(request, new URL(target), env, ctx);
        }

        if (url.pathname === '/robots.txt') return new Response("User-agent: *\nDisallow: /", { status: 200 });
        if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

        ctx.waitUntil(this.updateCount(env, 'total'));

        if (url.pathname === "/" || url.pathname === "") {
            const stats = await this.getStats(env);
            return new Response(renderHTML(url.hostname, stats), { 
                headers: { 'Content-Type': 'text/html; charset=utf-8' } 
            });
        }

        if (url.pathname.startsWith('/v2/') || url.pathname.includes('/token')) {
            ctx.waitUntil(this.updateCount(env, 'docker'));
            return handleDockerRequest(request, url);
        }

        let targetUrlStr = url.pathname.substring(1) + url.search;
        
        if (!targetUrlStr.startsWith('http')) {
            if (targetUrlStr.match(/^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}/)) {
                targetUrlStr = 'https://' + targetUrlStr;
            } else {
                const referer = request.headers.get('Referer');
                if (referer && referer.includes(url.origin)) {
                    try {
                        const refUrl = new URL(referer);
                        const rawPath = refUrl.pathname.substring(1);
                        if (rawPath.startsWith('http')) {
                            const baseUrl = new URL(rawPath);
                            targetUrlStr = new URL(targetUrlStr, baseUrl).href;
                        }
                    } catch(e) {}
                }
            }
        }

        try {
            if (!targetUrlStr.startsWith('http')) throw new Error('Invalid URL');
            const targetUrl = new URL(targetUrlStr);
            if (targetUrl.hostname.includes('github')) ctx.waitUntil(this.updateCount(env, 'github'));
            return this.processProxy(request, targetUrl, env, ctx);
        } catch (e) {
            return new Response(JSON.stringify({ error: 'Proxy Error', detail: e.message }, null, 2), { status: 400 });
        }
    },

    async processProxy(request, targetUrl, env, ctx) {
        return handleSmartProxy(request, targetUrl, new URL(request.url).origin);
    },

    async getStats(env) {
        if (!env.KV) return Config.DEFAULT_STATS();
        try {
            const [d, g, t] = await Promise.all([env.KV.get('hits_docker'), env.KV.get('hits_github'), env.KV.get('hits_total')]);
            const dVal = parseInt(d || 0), gVal = parseInt(g || 0), tVal = parseInt(t || 0);
            const dPer = Config.PROGRESS_GOAL > 0 ? Math.min(Math.round((dVal / Config.PROGRESS_GOAL) * 100), 100) : 0;
            const gPer = Config.PROGRESS_GOAL > 0 ? Math.min(Math.round((gVal / Config.PROGRESS_GOAL) * 100), 100) : 0;
            return { docker: dPer, dockerRaw: dVal, github: gPer, githubRaw: gVal, total: tVal, real: true };
        } catch (e) { return Config.DEFAULT_STATS(); }
    },

    async updateCount(env, type) {
        if (!env.KV) return;
        try {
            const k = `hits_${type}`;
            await env.KV.put(k, (parseInt(await env.KV.get(k) || 0) + 1).toString());
        } catch (e) {}
    }
};

async function handleSmartProxy(request, targetUrl, workerOrigin) {
    const headers = new Headers(request.headers);
    headers.set('Host', targetUrl.hostname);
    headers.set('Origin', targetUrl.origin);
    headers.set('Referer', targetUrl.href);
    headers.set('User-Agent', Config.UA_POOL[Math.floor(Math.random() * Config.UA_POOL.length)]);
    headers.delete('Accept-Encoding');

    const res = await fetch(new Request(targetUrl, {
        method: request.method,
        headers: headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.blob() : null,
        redirect: 'follow'
    }));

    const newHeaders = new Headers(res.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Access-Control-Allow-Credentials', 'true');
    ['content-security-policy', 'x-frame-options', 'frame-options', 'x-content-type-options'].forEach(k => newHeaders.delete(k));

    const contentType = newHeaders.get('content-type') || '';

    if (contentType.includes('text/html')) {
        return new HTMLRewriter()
            .on('head', { element(e) { e.prepend(INJECT_SCRIPT, { html: true }); } })
            .on('base', { element(e) { e.remove(); } })
            .on('a', new AttributeRewriter('href', workerOrigin, targetUrl))
            .on('img', new AttributeRewriter('src', workerOrigin, targetUrl))
            .on('script', new AttributeRewriter('src', workerOrigin, targetUrl))
            .on('link', new AttributeRewriter('href', workerOrigin, targetUrl))
            .on('form', new AttributeRewriter('action', workerOrigin, targetUrl))
            .on('iframe', new AttributeRewriter('src', workerOrigin, targetUrl))
            .transform(new Response(res.body, { status: res.status, headers: newHeaders }));
    }

    if (contentType.includes('text/css')) {
        let cssText = await res.text();
        cssText = cssText.replace(/url\(['"]?(https?:\/\/[^'"\)]+)['"]?\)/g, (match, url) => {
            if (Config.DIRECT_HOSTS.some(h => url.includes(h))) return `url("${url}")`;
            return `url("${workerOrigin}/${url}")`;
        });
        cssText = cssText.replace(/url\(['"]?(\/[^'"\)]+)['"]?\)/g, (match, path) => `url("${workerOrigin}/${targetUrl.origin}${path}")`);
        return new Response(cssText, { status: res.status, headers: newHeaders });
    }

    return new Response(res.body, { status: res.status, headers: newHeaders });
}

class AttributeRewriter {
    constructor(attr, worker, targetUrl) { this.attr = attr; this.worker = worker; this.targetUrl = targetUrl; }
    element(e) {
        const val = e.getAttribute(this.attr);
        if (!val || val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#')) return;
        try {
            const resolvedUrl = new URL(val, this.targetUrl.href).href;
            if (Config.DIRECT_HOSTS.some(host => resolvedUrl.includes(host))) {
                e.setAttribute(this.attr, resolvedUrl.replace(/^http:/, 'https:'));
                return;
            }
            e.setAttribute(this.attr, `${this.worker}/${resolvedUrl}`);
        } catch (err) {
            if (val.startsWith('http')) e.setAttribute(this.attr, `${this.worker}/${val}`);
        }
    }
}

async function handleDockerRequest(request, url) {
    const upstream = "registry-1.docker.io";
    const newUrl = new URL(upstream + url.pathname + url.search);
    newUrl.protocol = 'https:';
    if (url.pathname.includes('/token')) return fetch(new Request("https://auth.docker.io" + url.pathname + url.search, request));
    return iterativeFetch(request, newUrl, upstream);
}

async function iterativeFetch(request, targetUrl, host) {
    const isS3 = (u) => u.hostname.includes('amazonaws.com') || u.hostname.includes('r2.cloudflarestorage.com');
    let h = new Headers(request.headers);
    h.set('Host', host);
    if (!isS3(targetUrl)) h.set('Referer', targetUrl.origin);
    if (isS3(targetUrl)) {
        h.delete('Authorization');
        h.set('x-amz-content-sha256', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        h.set('x-amz-date', new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5) + 'Z');
    }
    let res = await fetch(new Request(targetUrl, { method: request.method, headers: h, redirect: 'manual' }));
    if ([301, 302, 307, 308].includes(res.status)) {
        const loc = res.headers.get('Location');
        if (loc) return iterativeFetch(request, new URL(loc), new URL(loc).hostname);
    }
    const n = new Headers(res.headers); n.set('Access-Control-Allow-Origin', '*');
    return new Response(res.body, { status: res.status, headers: n });
}

function renderHTML(domain, stats) {
    const mode = stats.real ? 'KV Active' : 'No Storage';
    const dockerText = stats.real ? `${stats.dockerRaw} / ${Config.PROGRESS_GOAL}` : 'N/A';
    const githubText = stats.real ? `${stats.githubRaw} / ${Config.PROGRESS_GOAL}` : 'N/A';
    
    return `
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OmniFlare Ultra</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <script>
        tailwind.config = { darkMode: 'class', theme: { extend: { fontFamily: { sans: ['Outfit', 'sans-serif'], mono: ['JetBrains Mono', 'monospace'] }, colors: { cosmic: { 900: '#0B0C15', 800: '#121426', 100: '#E2E8F0' }, accent: { cyan: '#22d3ee', violet: '#8b5cf6', pink: '#f472b6' } }, animation: { 'blob': 'blob 10s infinite', 'fade-in': 'fadeIn 0.5s ease-out forwards' }, keyframes: { blob: { '0%': { transform: 'translate(0px, 0px) scale(1)' }, '33%': { transform: 'translate(30px, -50px) scale(1.1)' }, '66%': { transform: 'translate(-20px, 20px) scale(0.9)' }, '100%': { transform: 'translate(0px, 0px) scale(1)' } }, fadeIn: { '0%': { opacity: '0', transform: 'translateY(10px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } } } } }
    </script>
    <style>
        body { background-color: #050505; color: #fff; overflow-x: hidden; }
        .noise-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; opacity: 0.04; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E"); }
        .aurora-bg { position: fixed; top: -50%; left: -50%; width: 200%; height: 200%; z-index: -1; background: radial-gradient(circle at 50% 50%, rgba(76, 29, 149, 0.15), rgba(15, 23, 42, 0)); }
        .orb { position: absolute; border-radius: 50%; filter: blur(80px); opacity: 0.4; animation: blob 15s infinite ease-in-out; }
        .orb-1 { top: 20%; left: 20%; width: 30vw; height: 30vw; background: #4f46e5; }
        .glass-panel { background: rgba(20, 20, 30, 0.6); backdrop-filter: blur(20px) saturate(180%); border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3); }
        .input-glow:focus { box-shadow: 0 0 20px rgba(34, 211, 238, 0.2); border-color: rgba(34, 211, 238, 0.5); }
    </style>
</head>
<body class="antialiased selection:bg-cyan-500/30">
    <div class="noise-overlay"></div>
    <div class="aurora-bg"><div class="orb orb-1"></div></div>

    <nav class="fixed top-0 w-full z-50 px-6 py-6 flex justify-between items-center border-b border-white/5 bg-black/20 backdrop-blur-md">
        <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-violet-600 flex items-center justify-center font-bold text-white shadow-lg shadow-cyan-500/20">O</div>
            <span class="font-bold tracking-tight text-lg">OmniFlare <span class="text-cyan-400 font-light text-sm align-top">Ultra</span></span>
        </div>
        <div class="flex items-center gap-3"><span class="flex h-2 w-2 relative"><span class="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span></span><span class="text-xs font-mono text-slate-400 uppercase tracking-widest">${mode}</span></div>
    </nav>

    <main class="max-w-7xl mx-auto pt-32 pb-20 px-4 sm:px-6 relative z-10">
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            <div class="lg:col-span-8 space-y-6 animate-fade-in">
                <div class="glass-panel rounded-[2rem] p-8 sm:p-10 relative overflow-hidden group">
                    <div class="relative z-10">
                        <div class="flex space-x-1 bg-black/40 p-1 rounded-xl w-fit mb-8 border border-white/5">
                            <button onclick="setMode('docker')" id="btn-docker" class="px-6 py-2 rounded-lg text-sm font-bold transition-all bg-white/10 text-white shadow-lg">Docker</button>
                            <button onclick="setMode('github')" id="btn-github" class="px-6 py-2 rounded-lg text-sm font-bold transition-all text-slate-400 hover:text-white">GitHub</button>
                            <button onclick="setMode('web')" id="btn-web" class="px-6 py-2 rounded-lg text-sm font-bold transition-all text-slate-400 hover:text-white">Web Proxy</button>
                        </div>
                        <h2 class="text-3xl sm:text-4xl font-bold mb-2 tracking-tight">Accelerate <span id="title-suffix" class="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-violet-500">Containers</span></h2>
                        <div class="relative group/input mt-8">
                            <input id="input-url" type="text" placeholder="nginx:latest" class="w-full bg-black/30 border border-white/10 rounded-2xl py-5 px-6 text-lg outline-none input-glow transition-all text-white placeholder-slate-600 font-mono">
                            <button onclick="execute()" class="absolute right-3 top-3 bottom-3 bg-white text-black px-6 rounded-xl font-bold hover:scale-95 transition-transform active:scale-90 flex items-center gap-2">LAUNCH</button>
                        </div>
                    </div>
                </div>
                <div id="output-card" class="glass-panel rounded-[2rem] p-0 hidden overflow-hidden border-l-4 border-l-cyan-400"><div class="bg-black/40 px-8 py-4 border-b border-white/5 flex justify-between items-center"><span class="text-xs font-mono text-cyan-400 uppercase tracking-widest">Console Output</span><button onclick="copyToClip()" class="text-xs font-bold text-slate-400 hover:text-white transition-colors">COPY</button></div><div class="p-8 font-mono text-sm sm:text-base break-all text-slate-300 selection:bg-cyan-500/40" id="result-text"></div></div>
            </div>

            <div class="lg:col-span-4 space-y-6 animate-fade-in" style="animation-delay: 0.1s">
                <div class="glass-panel rounded-[2rem] p-10 flex flex-col items-center justify-center text-center relative overflow-hidden group">
                    <div class="absolute inset-0 bg-gradient-to-b from-cyan-500/5 to-transparent"></div>
                    <div class="relative w-24 h-24 mb-8 flex items-center justify-center group-hover:scale-105 transition-transform duration-500">
                        <div class="absolute inset-0 bg-cyan-400/20 rounded-full animate-ping"></div>
                        <div class="absolute inset-0 bg-cyan-400/10 rounded-full animate-pulse"></div>
                        <div class="relative w-4 h-4 bg-cyan-400 rounded-full shadow-[0_0_20px_rgba(34,211,238,0.8)] z-10"></div>
                        <div class="absolute inset-2 border border-cyan-500/30 rounded-full border-dashed animate-[spin_10s_linear_infinite]"></div>
                    </div>

                    <span class="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500 mb-2">Total System Hits</span>
                    <span class="text-5xl font-black tracking-tighter text-white mb-2 drop-shadow-xl">${stats.total.toLocaleString()}</span>
                </div>

                <div class="glass-panel rounded-[2rem] p-8 space-y-6">
                    <div class="group">
                        <div class="flex justify-between mb-2">
                            <span class="text-sm font-medium text-slate-300">Docker Hits</span>
                            <span class="text-xs font-mono text-cyan-400 bg-cyan-950/50 px-2 py-0.5 rounded border border-cyan-500/20">${dockerText}</span>
                        </div>
                        <div class="w-full bg-white/5 rounded-full h-2 overflow-hidden">
                            <div class="bg-cyan-400 h-full rounded-full transition-all duration-1000" style="width: ${stats.docker}%"></div>
                        </div>
                    </div>
                    <div class="group">
                        <div class="flex justify-between mb-2">
                            <span class="text-sm font-medium text-slate-300">GitHub Hits</span>
                            <span class="text-xs font-mono text-purple-400 bg-purple-950/50 px-2 py-0.5 rounded border border-purple-500/20">${githubText}</span>
                        </div>
                        <div class="w-full bg-white/5 rounded-full h-2 overflow-hidden">
                            <div class="bg-purple-400 h-full rounded-full transition-all duration-1000" style="width: ${stats.github}%"></div>
                        </div>
                    </div>
                    <p class="text-[10px] text-slate-500 text-center pt-2">Goal: ${Config.PROGRESS_GOAL} requests / cycle</p>
                </div>
            </div>
        </div>
    </main>
    <div id="toast" class="fixed top-6 left-1/2 -translate-x-1/2 glass-panel px-6 py-3 rounded-full flex items-center gap-3 transition-all duration-300 opacity-0 -translate-y-10 pointer-events-none z-[100]"><span class="text-sm font-bold">Copied to clipboard</span></div>
    <script>
        let mode = 'docker'; const domain = window.location.hostname; const protocol = window.location.protocol;
        const presets = { docker: { ph: 'nginx:latest', title: 'Containers' }, github: { ph: 'https://github.com/user/repo...', title: 'Resources' }, web: { ph: 'https://google.com', title: 'The Web' } };
        function setMode(m) { mode = m; ['docker', 'github', 'web'].forEach(k => document.getElementById('btn-'+k).className = 'px-6 py-2 rounded-lg text-sm font-bold transition-all text-slate-400 hover:text-white'); document.getElementById('btn-'+m).className = 'px-6 py-2 rounded-lg text-sm font-bold transition-all bg-white/10 text-white shadow-lg'; document.getElementById('input-url').placeholder = 'Input ' + presets[m].ph + '...'; document.getElementById('title-suffix').innerText = presets[m].title; document.getElementById('output-card').classList.add('hidden'); }
        function execute() { const input = document.getElementById('input-url').value.trim(); if (!input) return; const baseUrl = protocol + '//' + domain; let result = '';
            if (mode === 'docker') { result = 'docker pull ' + domain + '/' + (input.includes('/') ? input : 'library/' + input); } 
            else if (mode === 'github') { result = baseUrl + '/https://github.com/' + input.replace(/^(https?:\\/\\/)?github\\.com\\//, ''); } 
            else { 
                const target = baseUrl + '/https://' + input.replace(/^(https?:\\/\\/)/, '');
                window.location.href = target;
                return;
            }
            document.getElementById('output-card').classList.remove('hidden'); document.getElementById('result-text').innerText = result; if(mode === 'docker') copyToClip();
        }
        function copyToClip() { navigator.clipboard.writeText(document.getElementById('result-text').innerText).then(() => { const t = document.getElementById('toast'); t.classList.remove('opacity-0', '-translate-y-10'); setTimeout(() => t.classList.add('opacity-0', '-translate-y-10'), 2000); }); }
        document.getElementById('input-url').addEventListener('keypress', (e) => { if (e.key === 'Enter') execute(); });
    </script>
</body>
</html>`;
}
