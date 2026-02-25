const express = require('express');
const { YtDlp } = require('ytdlp-nodejs');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');
const cors = require('cors');

const app = express();
const PORT = 3000;
const COOKIES = path.join(__dirname, 'cookies.txt');
const TEMP_DIR = path.join(__dirname, 'temp');

// --- INITIALIZATION ---
app.use(cors());
app.use(express.json());

if (!fs.existsSync(TEMP_DIR)) {
    console.log(`[SYSTEM] Creating temporary directory at: ${TEMP_DIR}`);
    fs.mkdirSync(TEMP_DIR);
}

const jobs = {};
let selectedEncoder = 'libx264';

// --- SYSTEM LOGGER HELPER ---
const logger = (jobId, message, type = 'INFO') => {
    const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    const idTag = jobId ? `[Job: ${jobId.substring(0, 8)}]` : '[SYSTEM]';
    const typeTag = `[${type}]`.padEnd(8);
    console.log(`${timestamp} ${idTag} ${typeTag} ${message}`);
};

// --- HARDWARE DETECTION ENGINE ---
const detectHardware = () => {
    console.log("\n" + "=".repeat(50));
    logger(null, "Probing Hardware Acceleration Capabilities...");
    try {
        const encoders = execSync('ffmpeg -encoders').toString();

        if (encoders.includes('h264_qsv')) {
            selectedEncoder = 'h264_qsv';
            logger(null, "SUCCESS: Found Intel QuickSync (h264_qsv)", "HARDWARE");
        } else if (encoders.includes('h264_nvenc')) {
            selectedEncoder = 'h264_nvenc';
            logger(null, "SUCCESS: Found NVIDIA NVENC (h264_nvenc)", "HARDWARE");
        } else if (encoders.includes('h264_videotoolbox')) {
            selectedEncoder = 'h264_videotoolbox';
            logger(null, "SUCCESS: Found Apple VideoToolbox (h264_videotoolbox)", "HARDWARE");
        } else if (encoders.includes('h264_amf')) {
            selectedEncoder = 'h264_amf';
            logger(null, "SUCCESS: Found AMD AMF (h264_amf)", "HARDWARE");
        } else {
            logger(null, "NOTICE: No hardware encoder detected. Using CPU (libx264).", "FALLBACK");
        }
    } catch (err) {
        logger(null, "ERROR: FFmpeg probe failed. Is FFmpeg installed?", "CRITICAL");
    }
    console.log("=".repeat(50) + "\n");
};
detectHardware();

// --- API: ANALYZE ---
app.post('/api/analyze', async (req, res) => {
    const { url } = req.body;
    logger(null, `Incoming analysis for URL: ${url}`);

    try {
        const ytdlp = new YtDlp();
        const info = await ytdlp.getInfoAsync(url, { cookies: COOKIES });
        logger(null, `Metadata retrieved for: "${info.title}"`);

        const formats = info.formats.map(f => {
            let label = "SD";
            if (f.vcodec !== 'none') {
                if (f.height >= 4320) label = "8K";
                else if (f.height >= 2160) label = "4K";
                else if (f.height >= 1440) label = "2K";
                else if (f.height >= 1080) label = "FHD";
                else if (f.height >= 720) label = "HD";
                else if (f.height >= 480) label = "SD";
                else label = "Low";
            } else {
                label = f.ext.toUpperCase();
            }

            return {
                id: f.format_id,
                ext: f.ext,
                height: f.height || 0,
                resolution: f.height ? `${f.height}p` : (f.width ? `${f.width}w` : 'N/A'),
                vcodec: f.vcodec !== 'none' ? f.vcodec : null,
                acodec: f.acodec !== 'none' ? f.acodec : null,
                size: f.filesize || f.filesize_approx || 0,
                abr: f.abr ? `${Math.round(f.abr)}kbps` : null,
                label: label,
                codec_info: f.vcodec !== 'none' ? f.vcodec.split('.')[0] : (f.acodec !== 'none' ? f.acodec.split('.')[0] : 'RAW')
            };
        });

        res.json({ title: info.title, thumbnail: info.thumbnail, formats });
    } catch (err) {
        logger(null, `Analysis failed: ${err.message}`, "ERROR");
        res.status(500).json({ error: err.message });
    }
});

// --- API: DOWNLOAD & PROCESS ---
app.post('/api/download', async (req, res) => {
    const { url, vId, aId, vLabel, aLabel, title } = req.body;
    const jobId = uuidv4();
    const extension = 'mp4'; // Hardcoded Video Container
    const namingTag = `${vLabel || 'NoVideo'}_${aLabel || 'NoAudio'}`;

    jobs[jobId] = { status: 'downloading', progress: '0%', file: null, customTag: namingTag, title };

    logger(jobId, `Download initiated for "${title}"`, "START");

    const ytdlp = new YtDlp();
    let formatSelection = (vId && aId) ? `${vId}+${aId}` : (vId || aId);

    let ffmpegArgs = [
        '--merge-output-format', extension,
        '--recode-video', extension,
        '--postprocessor-args', `ffmpeg:-c:v ${selectedEncoder} -preset fast -c:a aac -b:a 192k`,
        '--add-metadata',
        '--embed-thumbnail',
        '--convert-thumbnails', 'jpg'
    ];

    ytdlp.download(url)
        .cookies(COOKIES)
        .format(formatSelection)
        .output(TEMP_DIR)
        .on('progress', (p) => {
            if (jobs[jobId]) {
                jobs[jobId].progress = p.percentage_str || '0%';
                const pInt = parseInt(p.percentage_str);
                if (pInt % 25 === 0) logger(jobId, `Progress: ${p.percentage_str}`, "PROGRESS");
            }
        })
        .run(ffmpegArgs)
        .then((result) => {
            if (result.filePaths && result.filePaths.length > 0) {
                const finalFile = result.filePaths.find(p => p.endsWith(`.${extension}`)) || result.filePaths[0];
                if (jobs[jobId]) {
                    jobs[jobId].status = 'completed';
                    jobs[jobId].file = path.basename(finalFile);
                    logger(jobId, `Processing Finished. Output: ${jobs[jobId].file}`, "SUCCESS");
                }
            }
        })
        .catch((err) => {
            if (jobs[jobId]) jobs[jobId].status = 'error';
            logger(jobId, `Download/Merge error: ${err.message}`, "ERROR");
        });

    res.json({ jobId });
});

// --- API: STATUS ---
app.get('/api/status/:jobId', (req, res) => {
    res.json(jobs[req.params.jobId] || {});
});

// --- API: DELIVERY & CLEANUP ---
app.get('/api/file/:jobId/:title', (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job || job.status !== 'completed') return res.status(400).send('File not ready');

    const filePath = path.join(TEMP_DIR, job.file);
    const safeTitle = req.params.title.replace(/[^a-z0-9]/gi, '_');
    const finalName = `${safeTitle}_${job.customTag}${path.extname(job.file)}`;

    logger(req.params.jobId, `Transmitting file to client: ${finalName}`, "SEND");

    res.download(filePath, finalName, (err) => {
        if (err) {
            logger(req.params.jobId, `Transmission interrupted: ${err.message}`, "WARN");
        }

        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                logger(req.params.jobId, `CLEANUP: Deleted temporary file ${job.file}`, "DELETE");
            }
            delete jobs[req.params.jobId];
            logger(req.params.jobId, `Session closed. Memory purged.`, "PURGE");
        } catch (e) {
            logger(req.params.jobId, `Cleanup failed: ${e.message}`, "ERROR");
        }
    });
});

// --- SERVE THE UI ---
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en" class="scroll-smooth">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>YouTube Extract</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script>
            tailwind.config = {
                darkMode: 'class',
                theme: { extend: { colors: { brand: '#6366f1' } } }
            }
        </script>
        <style>
            .custom-scroll::-webkit-scrollbar { width: 4px; }
            .custom-scroll::-webkit-scrollbar-thumb { background: #6366f1; border-radius: 10px; }
            .badge-8k { background: linear-gradient(135deg, #f5e020, #fa9c0f); color: white; }
            .badge-4k { background: #ef4444; color: white; }
            .badge-hd { background: #3b82f6; color: white; }
        </style>
    </head>
    <body class="bg-slate-50 dark:bg-slate-950 min-h-screen p-4 md:p-10 font-sans text-slate-900 dark:text-slate-100 transition-colors duration-300">
        <div class="max-w-5xl mx-auto mb-6 flex justify-between items-center px-4">
            <h1 class="text-2xl font-black tracking-tighter text-brand italic uppercase">YouTube Extract</h1>
            <button onclick="toggleTheme()" class="p-2 rounded-xl bg-slate-200 dark:bg-slate-800 hover:scale-110 transition">
                <span id="theme-icon" class="text-xl">🌓</span>
            </button>
        </div>

        <div class="max-w-5xl mx-auto bg-white dark:bg-slate-900 shadow-2xl rounded-[2.5rem] overflow-hidden border border-slate-200 dark:border-slate-800">
            <div class="bg-brand p-12 text-center">
                <div class="flex flex-col md:flex-row gap-3 max-w-2xl mx-auto">
                    <input type="text" id="url" placeholder="Paste YouTube Link..." class="flex-1 px-6 py-4 rounded-2xl bg-white/10 border border-white/30 text-white placeholder-indigo-100 outline-none focus:ring-4 focus:ring-white/30 transition">
                    <button onclick="analyze()" class="bg-white text-brand px-10 py-4 rounded-2xl font-black hover:scale-105 transition active:scale-95 shadow-lg">ANALYZE</button>
                </div>
            </div>

            <div id="loader" class="hidden p-20 text-center text-brand animate-pulse font-bold text-xl uppercase tracking-widest">
                🚀 Scanning Streams...
            </div>

            <div id="result" class="hidden p-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div class="flex flex-col lg:flex-row gap-8 mb-10 items-center">
                    <img id="thumb" class="w-full lg:w-90 rounded-3xl shadow-xl border-4 border-slate-100 dark:border-slate-800" src="">
                    <div class="text-center lg:text-left">
                        <h2 id="title" class="text-2xl font-black mb-3 leading-tight"></h2>
                    </div>
                </div>

                <div class="grid lg:grid-cols-2 gap-8">
                    <div class="bg-slate-50 dark:bg-slate-950/50 p-6 rounded-[2rem] border border-slate-200 dark:border-slate-800">
                        <h3 class="font-black text-xl mb-6 text-brand italic">VIDEO STREAM</h3>
                        <div id="v-list" class="space-y-3 max-h-[400px] overflow-y-auto custom-scroll pr-3"></div>
                    </div>
                    <div class="bg-slate-50 dark:bg-slate-950/50 p-6 rounded-[2rem] border border-slate-200 dark:border-slate-800">
                        <h3 class="font-black text-xl mb-6 text-green-500 italic">AUDIO TRACK</h3>
                        <div id="a-list" class="space-y-3 max-h-[400px] overflow-y-auto custom-scroll pr-3"></div>
                    </div>
                </div>

                <div class="mt-12 p-10 bg-slate-50 dark:bg-slate-950/80 rounded-[2.5rem] flex flex-col items-center border border-slate-200 dark:border-slate-800">
                    <button onclick="download()" class="bg-brand text-white px-16 py-5 rounded-2xl font-black text-xl shadow-2xl hover:scale-105 active:scale-95 transition tracking-tighter">
                        START GENERATING
                    </button>
                    <div id="prog-box" class="w-full max-w-md mt-10 hidden">
                        <div class="flex justify-between text-[10px] font-black text-brand mb-3 uppercase tracking-tighter">
                            <span id="p-status">Merging tracks...</span>
                            <span id="p-val">0%</span>
                        </div>
                        <div class="w-full bg-slate-200 dark:bg-slate-800 h-4 rounded-full p-1 border border-slate-300 dark:border-slate-700">
                            <div id="p-bar" class="bg-brand h-full rounded-full transition-all duration-500" style="width:0%"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div id="modal" class="hidden fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div class="bg-white dark:bg-slate-900 rounded-[2.5rem] p-10 max-w-sm w-full text-center shadow-2xl border border-slate-200 dark:border-slate-800">
                <p id="modal-text" class="text-slate-500 dark:text-slate-400 font-medium leading-relaxed mb-8"></p>
                <button onclick="closeModal()" class="w-full bg-brand text-white py-4 rounded-2xl font-black hover:brightness-110 transition shadow-lg">UNDERSTOOD</button>
            </div>
        </div>

        <script>
            let currentMetadata = { title: "", formats: [] };
            const bytes = b => b ? (b / 1024 / 1024).toFixed(1) + ' MB' : 'Size N/A';

            function applyTheme() {
                const isDark = localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);
                document.documentElement.classList.toggle('dark', isDark);
            }

            function toggleTheme() {
                localStorage.theme = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
                applyTheme();
            }
            applyTheme();

            function showAlert(msg) {
                document.getElementById('modal-text').innerText = msg;
                document.getElementById('modal').classList.remove('hidden');
            }

            function closeModal() { document.getElementById('modal').classList.add('hidden'); }

            async function analyze() {
                const url = document.getElementById('url').value;
                if (!url) return showAlert("Input required.");
                document.getElementById('result').classList.add('hidden');
                document.getElementById('loader').classList.remove('hidden');
                try {
                    const res = await fetch('/api/analyze', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url })
                    });
                    const data = await res.json();
                    document.getElementById('loader').classList.add('hidden');
                    if (data.error) return showAlert("Error: " + data.error);
                    currentMetadata = data;
                    document.getElementById('title').innerText = data.title;
                    document.getElementById('thumb').src = data.thumbnail;
                    const vL = document.getElementById('v-list');
                    vL.innerHTML = createOption('v', '', 'No Video', 'SKIP VISUALS', 'bg-slate-200 dark:bg-slate-800', true);
                    const aL = document.getElementById('a-list');
                    aL.innerHTML = createOption('a', '', 'No Audio', 'SKIP SOUND', 'bg-slate-200 dark:bg-slate-800', true);
                    
                    data.formats.filter(f => f.vcodec)
                        .sort((a, b) => (b.height - a.height) || (b.size - a.size))
                        .forEach(f => {
                            let badge = 'bg-slate-500';
                            if (f.label === '8K') badge = 'badge-8k';
                            else if (f.label === '4K') badge = 'badge-4k';
                            else if (['2K', 'FHD', 'HD'].includes(f.label)) badge = 'badge-hd';
                            vL.innerHTML += createOption('v', f.id, f.resolution, \`\${f.label} • \${f.codec_info.toUpperCase()}\`, badge, false, bytes(f.size));
                        });

                    data.formats.filter(f => f.acodec && !f.vcodec)
                        .sort((a, b) => b.size - a.size)
                        .forEach(f => {
                            aL.innerHTML += createOption('a', f.id, f.abr || 'HQ', f.label, 'bg-green-500', false, bytes(f.size));
                        });
                    document.getElementById('result').classList.remove('hidden');
                } catch (e) {
                    document.getElementById('loader').classList.add('hidden');
                    showAlert("Network error.");
                }
            }

            function createOption(name, id, main, sub, badge, isSkip, size = '') {
                return \`<label class="flex items-center justify-between p-4 bg-white dark:bg-slate-900 rounded-2xl border-2 border-transparent hover:border-brand/40 cursor-pointer transition has-[:checked]:border-brand has-[:checked]:bg-brand/5">
                    <div class="flex items-center gap-4">
                        <input type="radio" name="\${name}" value="\${id}" data-label="\${main}" class="w-5 h-5 accent-brand" \${isSkip ? 'checked' : ''}>
                        <div>
                            <div class="flex items-center gap-2">
                                <span class="font-black text-sm uppercase dark:text-slate-100">\${main}</span>
                                <span class="text-[9px] font-black px-2 py-0.5 rounded \${badge} uppercase tracking-tighter">\${sub}</span>
                            </div>
                        </div>
                    </div>
                    <div class="text-[10px] font-black text-brand italic">\${size}</div>
                </label>\`;
            }

            async function download() {
                const vRadio = document.querySelector('input[name="v"]:checked');
                const aRadio = document.querySelector('input[name="a"]:checked');
                const vId = vRadio.value;
                const aId = aRadio.value;
                if (!vId && !aId) return showAlert("Selection invalid.");
                
                const res = await fetch('/api/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: document.getElementById('url').value,
                        vId, aId,
                        vLabel: vRadio.getAttribute('data-label'),
                        aLabel: aRadio.getAttribute('data-label'),
                        title: currentMetadata.title
                    })
                });
                const { jobId } = await res.json();
                document.getElementById('prog-box').classList.remove('hidden');
                const poll = setInterval(async () => {
                    const s = await (await fetch('/api/status/' + jobId)).json();
                    document.getElementById('p-bar').style.width = s.progress;
                    document.getElementById('p-val').innerText = s.progress;
                    if (s.status === 'completed') {
                        clearInterval(poll);
                        window.location.href = \`/api/file/\${jobId}/\${encodeURIComponent(currentMetadata.title)}\`;
                        setTimeout(() => { document.getElementById('prog-box').classList.add('hidden'); }, 3000);
                    }
                }, 1000);
            }
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log("\n" + "=".repeat(50));
    console.log(`🚀 YouTubeExtract Server running on http://localhost:${PORT}`);
    console.log(`📁 Temp Folder: ${TEMP_DIR}`);
    console.log("=".repeat(50) + "\n");
});