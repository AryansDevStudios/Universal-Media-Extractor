# 1. Cleanup and Install
killall -9 ttyd cloudflared node 2>/dev/null; rm -f app.log;
npm install && \

# 2. Start the App and Terminal in the background
(npm start > app.log 2>&1 &) && \
curl -L https://github.com/tsl0922/ttyd/releases/download/1.7.3/ttyd.x86_64 -o ttyd && chmod +x ttyd && \
(./ttyd -p 8080 bash &) && sleep 2 && \

# 3. Start the Tunnel, show the URL, and follow the logs
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cf && chmod +x cf && \
(./cf tunnel --url http://localhost:8080 2>&1 | grep --line-buffered -o 'https://.*\.trycloudflare.com' &) && \
echo "--- TUNNEL LIVE! WAIT FOR URL BELOW ---" && \
sleep 8 && tail -f app.log