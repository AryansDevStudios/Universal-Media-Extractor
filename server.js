const express = require('express');
const { YtDlp } = require('ytdlp-nodejs');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { execSync, spawn, spawnSync } = require('child_process');
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

// --- URL SANITIZER ---
const cleanMediaUrl = (rawUrl) => {
    try {
        const parsed = new URL(rawUrl);
        
        // Strip YouTube Playlist & Tracking Params
        if (parsed.hostname.includes('youtube.com')) {
            parsed.searchParams.delete('list');
            parsed.searchParams.delete('index');
            parsed.searchParams.delete('si');
            parsed.searchParams.delete('pp');
        } else if (parsed.hostname.includes('youtu.be')) {
            parsed.searchParams.delete('si');
            parsed.searchParams.delete('pp');
        }
        
        // Universal tracking parameters to strip for IG, TikTok, FB, Snap
        const trackingParams = ['igsh', 'utm_source', 'utm_medium', 'utm_campaign', 'is_from_webapp', 'sender_device', 'share_app_id', 'feature', 'fbclid'];
        trackingParams.forEach(param => parsed.searchParams.delete(param));
        
        return parsed.toString();
    } catch (e) {
        return rawUrl; // Fallback to raw URL if parsing fails
    }
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

// --- ROUTE: LOGO/FAVICON SERVING ---
app.get('/favicon.ico', (req, res) => {
    const logoPath = path.join(__dirname, 'favicon.ico');
    if (fs.existsSync(logoPath)) {
        res.sendFile(logoPath);
    } else {
        res.status(404).end();
    }
});

// Standard browser favicon request fallback
app.get('/favfavicon.ico', (req, res) => {
    const logoPath = path.join(__dirname, 'favicon.ico');
    if (fs.existsSync(logoPath)) {
        res.sendFile(logoPath);
    } else {
        res.status(404).end();
    }
});

// --- API: ANALYZE ---
app.post('/api/analyze', async (req, res) => {
    const { url } = req.body;
    const cleanedUrl = cleanMediaUrl(url); // Sanitize the URL to prevent playlist crashes
    logger(null, `Incoming analysis for URL: ${url}`);

    try {
        const ytdlp = new YtDlp();
        const info = await ytdlp.getInfoAsync(cleanedUrl, { cookies: COOKIES });
        logger(null, `Metadata retrieved for: "${info.title}"`);

        // Graceful error handling to prevent backend crash if a playlist still slips through
        if (!info.formats) {
            throw new Error("No video stream found. Please ensure the link points to a specific video, not a channel or playlist.");
        }

        // Safely map formats (Supports YT, FB, IG, TT, Snap natively now)
        const formats = info.formats.map(f => {
            let label = "SD";
            
            // Fix: Treat missing codec fields as present unless explicitly flagged as 'none' (fixes Snapchat/IG)
            const hasVideo = f.vcodec !== 'none';
            const hasAudio = f.acodec !== 'none';

            // Smart orientation detection for vertical videos (TikTok, Shorts, Reels)
            const width = f.width || 0;
            const height = f.height || 0;
            const isVertical = height > width && width > 0;
            
            // Use the shortest edge to accurately determine quality category (HD, FHD, 4K)
            let shortEdge = height;
            if (width && height) {
                shortEdge = Math.min(width, height);
            } else if (width && !height) {
                shortEdge = width;
            }

            if (hasVideo) {
                if (shortEdge >= 4320) label = "8K";
                else if (shortEdge >= 2160) label = "4K";
                else if (shortEdge >= 1440) label = "2K";
                else if (shortEdge >= 1080) label = "FHD";
                else if (shortEdge >= 720) label = "HD";
                else if (shortEdge >= 480) label = "SD";
                else label = "Low";
            } else {
                label = f.ext ? f.ext.toUpperCase() : "RAW";
            }

            // Determine correct display resolution text (e.g., show '1080p' for a 1080x1920 video)
            let resDisplay = 'Native';
            if (width && height) {
                resDisplay = isVertical ? `${width}p` : `${height}p`;
            } else if (height) {
                resDisplay = `${height}p`;
            } else if (width) {
                resDisplay = `${width}w`;
            }

            return {
                id: f.format_id,
                ext: f.ext,
                height: height || 0, // Kept for backend sorting logic
                resolution: resDisplay,
                vcodec: hasVideo ? (f.vcodec || 'unknown') : null,
                acodec: hasAudio ? (f.acodec || 'unknown') : null,
                size: f.filesize || f.filesize_approx || 0,
                abr: f.abr ? `${Math.round(f.abr)}kbps` : null,
                label: label,
                codec_info: hasVideo ? (f.vcodec ? f.vcodec.split('.')[0] : 'VID') : (hasAudio ? (f.acodec ? f.acodec.split('.')[0] : 'AUD') : 'RAW')
            };
        });

        res.json({ title: info.title, thumbnail: info.thumbnail, formats });
    } catch (err) {
        logger(null, `Analysis failed: ${err.message}`, "ERROR");
        res.status(500).json({ error: err.message });
    }
});

// --- API: THUMBNAIL DOWNLOADER (Server-Side Bypass for CORS + WebP to PNG) ---
app.get('/api/thumbnail', (req, res) => {
    const { imgUrl, title } = req.query;
    if (!imgUrl) return res.status(400).send('No image URL provided');

    // Security check: ensure URL is an actual web resource
    try {
        const parsedUrl = new URL(imgUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
    } catch (e) {
        return res.status(400).send('Invalid URL format');
    }

    const safeTitle = (title || 'thumbnail').replace(/[^a-z0-9]/gi, '_');
    
    // Force browser to treat as a downloadable PNG file
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_thumb.png"`);
    res.setHeader('Content-Type', 'image/png');

    // Pipe the image through FFmpeg to convert it (e.g. YouTube WebP) into a high-quality PNG on the fly
    const ffmpegProcess = spawn('ffmpeg', [
        '-i', imgUrl,
        '-vframes', '1',
        '-c:v', 'png',
        '-f', 'image2pipe',
        'pipe:1'
    ]);

    ffmpegProcess.stdout.pipe(res);

    ffmpegProcess.on('error', (err) => {
        logger(null, `Thumbnail conversion error: ${err.message}`, "ERROR");
        if (!res.headersSent) res.status(500).send('Failed to process thumbnail');
    });
});

// --- API: DOWNLOAD & PROCESS ---
app.post('/api/download', async (req, res) => {
    const { url, vId, aId, vLabel, aLabel, title } = req.body;
    const cleanedUrl = cleanMediaUrl(url); 
    const jobId = uuidv4();
    const extension = 'mp4'; 
    const namingTag = `${vLabel || 'NoVideo'}_${aLabel || 'NoAudio'}`;

    jobs[jobId] = { status: 'downloading', progress: '0%', file: null, customTag: namingTag, title };

    logger(jobId, `Download initiated for "${title}"`, "START");

    const ytdlp = new YtDlp();
    let formatSelection = (vId && aId) ? `${vId}+${aId}` : (vId || aId);

    // TASK 1: Re-encode to MP4 and download the thumbnail safely (No embedding yet)
    let ffmpegArgs = [
        '--merge-output-format', extension,
        '--recode-video', extension,
        '--postprocessor-args', `VideoConvertor:-c:V ${selectedEncoder} -preset fast -c:a aac -b:a 192k`,
        '--postprocessor-args', `Merger:-c:V ${selectedEncoder} -preset fast -c:a aac -b:a 192k`,
        '--add-metadata',
        '--write-thumbnail',    // Forces yt-dlp to save the thumbnail alongside the video
        '--convert-thumbnails', 'jpg' // Guarantees the thumbnail is cleanly converted to JPG
    ];

    ytdlp.download(cleanedUrl)
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
                const baseName = finalFile.substring(0, finalFile.lastIndexOf('.'));
                
                // Locate the safely extracted JPG thumbnail 
                const possibleThumbs = [baseName + '.jpg', baseName + '.webp', baseName + '.png'];
                const thumbFile = possibleThumbs.find(f => fs.existsSync(f));

                // TASK 2: Use an isolated FFmpeg operation to natively embed the thumbnail
                if (thumbFile && fs.existsSync(finalFile)) {
                    try {
                        logger(jobId, `Task 2: Injecting high-res thumbnail into MP4...`, "THUMB");
                        const embeddedFile = baseName + '_with_thumb.' + extension;
                        
                        // -c copy ensures we don't re-encode the video again, we just inject the picture
                        spawnSync('ffmpeg', [
                            '-y',
                            '-i', finalFile,
                            '-i', thumbFile,
                            '-map', '0',
                            '-map', '1',
                            '-c', 'copy',
                            '-c:v:1', 'mjpeg',
                            '-disposition:v:1', 'attached_pic',
                            embeddedFile
                        ]);

                        // Replace the original with our newly embedded version
                        if (fs.existsSync(embeddedFile)) {
                            fs.unlinkSync(finalFile);
                            fs.unlinkSync(thumbFile);
                            fs.renameSync(embeddedFile, finalFile);
                        }
                    } catch (err) {
                        logger(jobId, `Thumbnail injection failed, proceeding with original. Error: ${err.message}`, "WARN");
                    }
                }

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
    
    // Strictly force the .mp4 extension for maximum compatibility delivery
    const finalName = `${safeTitle}_${job.customTag}.mp4`;

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
        <title>Universal Media Extractor</title>
        
        <!-- SITE LOGO & FAVICON -->
        <link rel="icon" href="/favicon.ico" type="image/x-icon">
        <link rel="shortcut icon" href="/favicon.ico" type="image/x-icon">

        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Updock&display=swap" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Pacifico&display=swap" rel="stylesheet">
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
    <body class="bg-slate-50 dark:bg-slate-950 min-h-screen p-3 sm:p-4 md:p-10 font-sans text-slate-900 dark:text-slate-100 transition-colors duration-300">
        <!-- TOAST CONTAINER -->
        <div id="toast-container" class="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 z-50 flex flex-col gap-2 pointer-events-none md:max-w-sm"></div>

        <div class="max-w-5xl mx-auto mb-4 md:mb-6 flex justify-between items-center px-2 md:px-4">
            <div class="flex items-center gap-3">
                <img src="/favicon.ico" class="w-10 h-10 md:w-10 md:h-10 rounded-lg shadow-md" alt="Logo" onerror="this.style.display='none'">
                <div>
                    <h1 class="text-2xl md:text-3xl text-brand" style="font-family: 'Pacifico', cursive;">Universal Media Extractor</h1> 
                    <p class="text-[9px] md:text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-0.5 md:mt-1">Multi-Platform Supported</p>
                </div>
            </div>
            <button onclick="toggleTheme()" class="p-2 md:p-2 rounded-xl bg-slate-200 dark:bg-slate-800 hover:scale-110 transition">
                <span id="theme-icon" class="text-lg md:text-xl">☀</span>
            </button>
        </div>

        <div class="max-w-5xl mx-auto bg-white dark:bg-slate-900 shadow-2xl rounded-3xl md:rounded-[2.5rem] overflow-hidden border border-slate-200 dark:border-slate-800 relative z-10">
            <div class="bg-brand p-6 md:p-12 text-center">
                <div class="flex flex-col md:flex-row gap-3 max-w-2xl mx-auto relative">
                    <!-- INPUT GROUP WITH QUICK ACTIONS -->
                    <div class="relative flex-1 group w-full">
                        <input type="text" id="url" placeholder="Paste Video Link Here..." class="w-full px-4 py-3 md:px-6 md:py-4 pr-24 rounded-2xl bg-white/10 border border-white/30 text-white placeholder-indigo-100 outline-none focus:ring-4 focus:ring-white/30 transition shadow-inner text-sm md:text-base">
                        <div class="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1 opacity-100 md:opacity-70 group-hover:opacity-100 transition">
                            <button onclick="clearInput()" class="p-1.5 md:p-2 hover:bg-white/20 rounded-xl transition text-white" title="Clear Input">
                                <svg class="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                            </button>
                            <button onclick="pasteInput()" class="p-1.5 md:p-2 hover:bg-white/20 rounded-xl transition text-white" title="Paste & Analyze">
                                <svg class="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path></svg>
                            </button>
                        </div>
                    </div>
                    <button onclick="analyze()" class="w-full md:w-auto bg-white text-brand px-6 py-3 md:px-10 md:py-4 rounded-2xl font-black hover:scale-105 transition active:scale-95 shadow-lg text-sm md:text-base">ANALYZE</button>
                </div>
                
                <!-- SUPPORTED PLATFORMS BADGES -->
                <div class="mt-4 md:mt-6 flex flex-wrap justify-center gap-1.5 md:gap-2 text-[9px] md:text-[10px] font-black uppercase tracking-widest text-white/80">
                    <span class="px-2 py-1 md:px-3 md:py-1.5 rounded-lg bg-white/10 border border-white/20">YouTube</span>
                    <span class="px-2 py-1 md:px-3 md:py-1.5 rounded-lg bg-white/10 border border-white/20">Instagram Reels</span>
                    <span class="px-2 py-1 md:px-3 md:py-1.5 rounded-lg bg-white/10 border border-white/20">Facebook Reels/Posts</span>
                    <span class="px-2 py-1 md:px-3 md:py-1.5 rounded-lg bg-white/10 border border-white/20">Snapchat Spotlight</span>                    
                </div>
            </div>

            <!-- SKELETON LOADER -->
            <div id="loader" class="hidden p-4 md:p-8 animate-pulse">
                <div class="flex flex-col lg:flex-row gap-4 md:gap-8 mb-6 md:mb-10 items-center lg:items-start">
                    <div class="w-full lg:w-72 h-48 bg-slate-200 dark:bg-slate-800 rounded-2xl md:rounded-3xl"></div>
                    <div class="flex-1 w-full space-y-3 py-2 md:py-4">
                        <div class="h-6 md:h-8 bg-slate-200 dark:bg-slate-800 rounded-xl w-3/4"></div>
                        <div class="h-4 bg-slate-200 dark:bg-slate-800 rounded-xl w-1/2"></div>
                    </div>
                </div>
                <div class="grid lg:grid-cols-2 gap-4 md:gap-8">
                    <div class="h-48 md:h-64 bg-slate-200 dark:bg-slate-800 rounded-2xl md:rounded-[2rem]"></div>
                    <div class="h-48 md:h-64 bg-slate-200 dark:bg-slate-800 rounded-2xl md:rounded-[2rem]"></div>
                </div>
            </div>

            <div id="result" class="hidden p-4 md:p-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div class="flex flex-col lg:flex-row gap-4 md:gap-8 mb-6 md:mb-10 items-center lg:items-start">
                    <div class="flex flex-col gap-3 w-full lg:w-72">
                        <img id="thumb" class="w-full rounded-2xl md:rounded-3xl shadow-xl border-2 md:border-4 border-slate-100 dark:border-slate-800" src="">
                        <button onclick="downloadThumbnail()" class="w-full bg-slate-200 dark:bg-slate-800 hover:bg-brand hover:text-white dark:hover:bg-brand text-slate-700 dark:text-slate-300 font-bold text-[10px] md:text-[11px] py-2.5 md:py-3 rounded-xl transition shadow-sm flex items-center justify-center gap-2 tracking-wider">
                            <svg class="w-3.5 h-3.5 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                            DOWNLOAD THUMBNAIL
                        </button>
                    </div>
                    <div class="text-center lg:text-left flex-1 relative w-full">
                        <h2 id="title" class="text-lg md:text-2xl font-black mb-2 md:mb-3 leading-tight px-1"></h2>
                    </div>
                </div>

                <!-- ADVANCED VIEW TOGGLE -->
                <div class="flex justify-end mb-3 md:mb-4 px-1 md:px-2">
                    <label class="flex items-center gap-2 cursor-pointer text-[10px] md:text-xs font-black uppercase tracking-widest text-slate-500 dark:text-slate-400 hover:text-brand transition">
                        <div class="relative">
                            <input type="checkbox" id="adv-toggle" class="peer sr-only" onchange="toggleAdvanced()">
                            <div class="w-7 md:w-8 h-4 bg-slate-300 dark:bg-slate-700 rounded-full peer peer-checked:bg-brand transition-colors"></div>
                            <div class="absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform peer-checked:translate-x-3 md:peer-checked:translate-x-4"></div>
                        </div>
                        Show All Codecs
                    </label>
                </div>

                <div class="grid lg:grid-cols-2 gap-4 md:gap-8" id="stream-lists-container">
                    <div class="bg-slate-50 dark:bg-slate-950/50 p-4 md:p-6 rounded-2xl md:rounded-[2rem] border border-slate-200 dark:border-slate-800">
                        <h3 class="font-black text-sm md:text-xl mb-4 md:mb-6 text-brand italic">VIDEO STREAM</h3>
                        <div id="v-list" class="space-y-2.5 md:space-y-3 max-h-[350px] md:max-h-[400px] overflow-y-auto custom-scroll pr-2 md:pr-3"></div>
                    </div>
                    <div class="bg-slate-50 dark:bg-slate-950/50 p-4 md:p-6 rounded-2xl md:rounded-[2rem] border border-slate-200 dark:border-slate-800">
                        <h3 class="font-black text-sm md:text-xl mb-4 md:mb-6 text-green-500 italic">AUDIO TRACK</h3>
                        <div id="a-list" class="space-y-2.5 md:space-y-3 max-h-[350px] md:max-h-[400px] overflow-y-auto custom-scroll pr-2 md:pr-3"></div>
                    </div>
                </div>

                <div class="mt-6 md:mt-12 p-6 md:p-10 bg-slate-50 dark:bg-slate-950/80 rounded-2xl md:rounded-[2.5rem] flex flex-col items-center border border-slate-200 dark:border-slate-800">
                    
                    <!-- SIZE ESTIMATOR UI -->
                    <div id="size-estimator" class="text-[10px] md:text-xs font-black uppercase tracking-widest text-slate-500 mb-4 md:mb-6 bg-slate-200 dark:bg-slate-800 px-4 md:px-6 py-1.5 md:py-2 rounded-xl transition-all shadow-inner text-center w-full md:w-auto">
                        Estimated Size: <span id="size-val" class="text-brand text-sm ml-1 block sm:inline mt-1 sm:mt-0">-- MB</span>
                    </div>

                    <button onclick="download()" class="w-full sm:w-auto bg-brand text-white px-8 md:px-16 py-4 md:py-5 rounded-xl md:rounded-2xl font-black text-base md:text-xl shadow-2xl hover:scale-105 active:scale-95 transition tracking-tighter">
                        START GENERATING
                    </button>
                    
                    <div id="prog-box" class="w-full max-w-md mt-6 md:mt-10 hidden">
                        <div class="flex justify-between text-[9px] md:text-[10px] font-black text-brand mb-2 md:mb-3 uppercase tracking-tighter">
                            <span id="p-status">Processing...</span>
                            <span id="p-val">0%</span>
                        </div>
                        <div class="w-full bg-slate-200 dark:bg-slate-800 h-3 md:h-4 rounded-full p-0.5 md:p-1 border border-slate-300 dark:border-slate-700">
                            <div id="p-bar" class="bg-brand h-full rounded-full transition-all duration-500" style="width:0%"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- RECENT SEARCH HISTORY -->
        <div id="recent-wrapper" class="hidden max-w-5xl mx-auto mt-6 md:mt-8 px-2 md:px-4 relative z-0">
            <h3 class="text-[10px] md:text-xs font-black uppercase tracking-widest text-slate-500 mb-3 md:mb-4 px-2">Recent Searches</h3>
            <div id="recent-list" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
                <!-- Dynamically Populated -->
            </div>
        </div>

        <!-- FOOTER -->
        <footer class="text-center text-sm mt-12 mb-6 space-y-1">
          <div class="text-slate-800 dark:text-slate-200">
            © 2026 
            <span class="bg-gradient-to-r from-red-500 to-orange-500 bg-clip-text text-transparent font-black tracking-wide">
              AryansDevStudios
            </span>
            <span class="mx-1 text-slate-400">×</span>
            <span class="font-normal text-2xl relative top-1.5" style="font-family: 'Updock', cursive;">
              Divyanshverse
            </span>
          </div>
          <div class="text-slate-500 dark:text-slate-500 text-[10px] uppercase tracking-widest font-bold">
            <a href="https://github.com/AryansDevStudios/Universal-Media-Extractor" target="_blank" rel="noopener noreferrer" class="hover:text-brand transition-colors underline decoration-transparent hover:decoration-brand underline-offset-4">
              Open-source & free to use
            </a>
          </div>
        </footer>

        <script>
            let currentMetadata = { title: "", formats: [] };
            let advancedMode = false;
            
            const bytes = b => b ? (b / 1024 / 1024).toFixed(1) + ' MB' : 'Unknown Size';

            function applyTheme() {
                const isDark = localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);
                document.documentElement.classList.toggle('dark', isDark);
            }

            function toggleTheme() {
                localStorage.theme = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
                applyTheme();
            }
            applyTheme();

            // TOAST NOTIFICATION SYSTEM
            function showToast(msg, type = 'info') {
                const container = document.getElementById('toast-container');
                const toast = document.createElement('div');
                const colors = type === 'error' ? 'bg-red-500' : (type === 'success' ? 'bg-green-500' : 'bg-brand');
                toast.className = \`px-4 md:px-6 py-3 md:py-4 rounded-xl md:rounded-2xl text-white font-black text-xs md:text-sm shadow-2xl \${colors} transition-all transform duration-300 translate-y-10 opacity-0 flex items-center gap-2 md:gap-3\`;
                
                const icon = type === 'error' ? '<svg class="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>' 
                           : '<svg class="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
                
                toast.innerHTML = \`\${icon} \${msg}\`;
                container.appendChild(toast);
                
                requestAnimationFrame(() => {
                    toast.classList.remove('translate-y-10', 'opacity-0');
                });
                
                setTimeout(() => {
                    toast.classList.add('translate-y-10', 'opacity-0');
                    setTimeout(() => toast.remove(), 300);
                }, 4000);
            }

            // INPUT CONTROLS
            function clearInput() {
                document.getElementById('url').value = '';
                document.getElementById('url').focus();
            }

            async function pasteInput() {
                try {
                    const text = await navigator.clipboard.readText();
                    document.getElementById('url').value = text;
                    analyze();
                } catch (e) {
                    showToast("Clipboard access denied. Please paste manually.", "error");
                }
            }

            // Initialization & URL params
            window.addEventListener('DOMContentLoaded', () => {
                const urlInput = document.getElementById('url');
                
                urlInput.addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        analyze();
                    }
                });

                const urlParams = new URLSearchParams(window.location.search);
                const queryUrl = urlParams.get('search') || urlParams.get('url');
                if (queryUrl) {
                    urlInput.value = queryUrl;
                    setTimeout(analyze, 300);
                }

                loadRecent();
            });

            // UPDATED: Triggers backend thumbnail generation and returns an exact PNG file stream
            function downloadThumbnail() {
                if (!currentMetadata.thumbnail) return showToast("No thumbnail available", "error");
                
                showToast("Converting high-res thumbnail to PNG...", "info");
                
                const url = \`/api/thumbnail?imgUrl=\${encodeURIComponent(currentMetadata.thumbnail)}&title=\${encodeURIComponent(currentMetadata.title)}\`;
                
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }

            // RECENT SEARCH HISTORY LOCAL STORAGE
            function saveRecent(metadata, rawUrl) {
                let recent = JSON.parse(localStorage.getItem('umx_recent') || '[]');
                recent = recent.filter(r => r.url !== rawUrl);
                recent.unshift({ title: metadata.title, thumb: metadata.thumbnail, url: rawUrl });
                if (recent.length > 20) recent.pop(); // Keep last 20 searches purely as light history
                localStorage.setItem('umx_recent', JSON.stringify(recent));
                loadRecent();
            }

            function loadRecent() {
                const wrapper = document.getElementById('recent-wrapper');
                let recent = JSON.parse(localStorage.getItem('umx_recent') || '[]');
                const container = document.getElementById('recent-list');
                
                if (recent.length === 0) {
                    wrapper.classList.add('hidden');
                    return;
                }
                wrapper.classList.remove('hidden');
                
                container.innerHTML = recent.map(r => \`
                    <div class="flex items-center gap-3 md:gap-4 p-3 md:p-4 bg-white dark:bg-slate-900 rounded-xl md:rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 cursor-pointer hover:border-brand dark:hover:border-brand transition group relative" onclick="loadFromHistory('\${r.url.replace(/'/g, "\\\\'")}')">
                        <img src="\${r.thumb}" class="w-12 h-12 md:w-14 md:h-14 object-cover rounded-lg md:rounded-xl shadow-sm bg-slate-100">
                        <div class="flex-1 min-w-0 pr-8">
                            <h4 class="font-bold text-xs md:text-sm truncate dark:text-slate-100 group-hover:text-brand transition">\${r.title}</h4>
                            <p class="text-[9px] md:text-[10px] text-slate-500 truncate mt-0.5 md:mt-1">\${r.url}</p>
                        </div>
                        <button onclick="deleteRecent('\${r.url.replace(/'/g, "\\\\'")}', event)" class="absolute right-2 md:right-3 p-1.5 md:p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg md:rounded-xl transition" title="Remove from history">
                            <svg class="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                        </button>
                    </div>
                \`).join('');
            }

            function deleteRecent(url, event) {
                event.stopPropagation(); // Prevents triggering the loadFromHistory action underneath
                let recent = JSON.parse(localStorage.getItem('umx_recent') || '[]');
                recent = recent.filter(r => r.url !== url);
                localStorage.setItem('umx_recent', JSON.stringify(recent));
                loadRecent();
                showToast("Removed from history", "info");
            }

            function loadFromHistory(url) {
                document.getElementById('url').value = url;
                window.scrollTo({ top: 0, behavior: 'smooth' });
                analyze();
            }

            async function analyze() {
                const url = document.getElementById('url').value;
                if (!url) return showToast("Please paste a URL first.", "error");
                
                const currentUrl = new URL(window.location.href);
                currentUrl.searchParams.set('search', url);
                window.history.pushState({}, '', currentUrl);

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
                    
                    if (data.error) {
                        return showToast(data.error, "error");
                    }
                    
                    currentMetadata = data;
                    document.getElementById('title').innerText = data.title;
                    document.getElementById('thumb').src = data.thumbnail;
                    
                    saveRecent(data, url); // Save lightweight search to history on successful analysis
                    renderLists();
                    
                    document.getElementById('result').classList.remove('hidden');
                    showToast("Analysis Complete", "success");
                } catch (e) {
                    document.getElementById('loader').classList.add('hidden');
                    showToast("Network error. Could not connect to server.", "error");
                }
            }

            // DYNAMIC RENDERING & ADVANCED TOGGLE
            function toggleAdvanced() {
                advancedMode = document.getElementById('adv-toggle').checked;
                renderLists();
            }

            function renderLists() {
                const vL = document.getElementById('v-list');
                const aL = document.getElementById('a-list');
                vL.innerHTML = ''; 
                aL.innerHTML = '';
                
                // --- Video Processing ---
                let vFormats = currentMetadata.formats.filter(f => f.vcodec).sort((a, b) => (b.height - a.height) || (b.size - a.size));
                
                if (!advancedMode) {
                    const seenRes = new Set();
                    vFormats = vFormats.filter(f => {
                        if (seenRes.has(f.resolution)) return false;
                        seenRes.add(f.resolution);
                        return true;
                    });
                }

                vL.innerHTML += createOption('v', '', 'No Video', 'SKIP VISUALS', 'bg-slate-200 dark:bg-slate-800', vFormats.length === 0, 0);
                
                vFormats.forEach((f, idx) => {
                    let badge = 'bg-slate-500';
                    if (f.label === '8K') badge = 'badge-8k';
                    else if (f.label === '4K') badge = 'badge-4k';
                    else if (['2K', 'FHD', 'HD'].includes(f.label)) badge = 'badge-hd';
                    
                    // Auto-select the top result
                    let isSkip = idx === 0;
                    vL.innerHTML += createOption('v', f.id, f.resolution, \`\${f.label} • \${f.codec_info.toUpperCase()}\`, badge, isSkip, f.size);
                });

                // --- Audio Processing ---
                const audioFormats = currentMetadata.formats.filter(f => f.acodec && !f.vcodec);
                if (audioFormats.length > 0) {
                    let aFormats = audioFormats.sort((a, b) => b.size - a.size);
                    
                    if (!advancedMode) {
                        aFormats = [aFormats[0]]; // Only show best audio in basic mode
                    }
                    
                    aL.innerHTML += createOption('a', '', 'No Audio', 'SKIP SOUND', 'bg-slate-200 dark:bg-slate-800', false, 0);
                    aFormats.forEach((f, idx) => {
                        aL.innerHTML += createOption('a', f.id, f.abr || 'HQ', f.label, 'bg-green-500', idx === 0, f.size);
                    });
                } else {
                    aL.innerHTML = createOption('a', '', 'Audio Included', 'PRE-MERGED', 'bg-green-500', true, 0);
                }

                updateEstimatedSize();
            }

            function createOption(name, id, main, sub, badge, isSkip, rawSize) {
                const sizeStr = rawSize > 0 ? bytes(rawSize) : (id === '' ? '' : 'Unknown Size');
                return \`<label class="flex items-center justify-between p-3 md:p-4 bg-white dark:bg-slate-900 rounded-xl md:rounded-2xl border-2 border-transparent hover:border-brand/40 cursor-pointer transition has-[:checked]:border-brand has-[:checked]:bg-brand/5">
                    <div class="flex items-center gap-3 md:gap-4">
                        <input type="radio" name="\${name}" value="\${id}" data-label="\${main}" data-size="\${rawSize}" class="w-4 h-4 md:w-5 md:h-5 accent-brand" \${isSkip ? 'checked' : ''} onchange="updateEstimatedSize()">
                        <div>
                            <div class="flex items-center gap-1.5 md:gap-2">
                                <span class="font-black text-xs md:text-sm uppercase dark:text-slate-100">\${main}</span>
                                <span class="text-[8px] md:text-[9px] font-black px-1.5 md:px-2 py-0.5 rounded \${badge} uppercase tracking-tighter">\${sub}</span>
                            </div>
                        </div>
                    </div>
                    <div class="text-[9px] md:text-[10px] font-black text-brand italic">\${sizeStr}</div>
                </label>\`;
            }

            // DYNAMIC FILE SIZE ESTIMATOR
            function updateEstimatedSize() {
                const vNode = document.querySelector('input[name="v"]:checked');
                const aNode = document.querySelector('input[name="a"]:checked');
                
                let totalBytes = 0;
                if (vNode && vNode.dataset.size) totalBytes += parseInt(vNode.dataset.size) || 0;
                if (aNode && aNode.dataset.size) totalBytes += parseInt(aNode.dataset.size) || 0;

                const sizeUI = document.getElementById('size-val');
                if (totalBytes > 0) {
                    sizeUI.innerText = \`~\${(totalBytes / 1024 / 1024).toFixed(1)} MB\`;
                    sizeUI.classList.remove('text-slate-400');
                } else {
                    sizeUI.innerText = "Unknown Size";
                    sizeUI.classList.add('text-slate-400');
                }
            }

            async function download() {
                const vRadio = document.querySelector('input[name="v"]:checked');
                const aRadio = document.querySelector('input[name="a"]:checked');
                const vId = vRadio ? vRadio.value : '';
                const aId = aRadio ? aRadio.value : '';
                
                if (!vId && !aId) return showToast("Selection invalid. Choose a stream.", "error");

                showToast("Task Started: Processing media...", "info");

                const res = await fetch('/api/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: document.getElementById('url').value,
                        vId, aId,
                        vLabel: vRadio ? vRadio.getAttribute('data-label') : 'NoVideo',
                        aLabel: aRadio ? aRadio.getAttribute('data-label') : 'NoAudio',
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
                        showToast("File ready! Downloading...", "success");
                        window.location.href = \`/api/file/\${jobId}/\${encodeURIComponent(currentMetadata.title)}\`;
                        setTimeout(() => { document.getElementById('prog-box').classList.add('hidden'); }, 3000);
                    } else if (s.status === 'error') {
                        clearInterval(poll);
                        showToast("Processing failed. Check server logs.", "error");
                        document.getElementById('prog-box').classList.add('hidden');
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
    console.log(`[SERVER] YouTubeExtract Server running on http://localhost:${PORT}`);
    console.log(`[TEMP] Temp Folder: ${TEMP_DIR}`);
    console.log("=".repeat(50) + "\n");
});