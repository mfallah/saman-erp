# Shared reverse-proxy directives for the Saman ERP API upstream.
# Included by location blocks in /etc/nginx/conf.d/default.conf.
proxy_http_version 1.1;

proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header Connection        "";

proxy_connect_timeout 5s;
proxy_read_timeout    30s;
proxy_send_timeout    30s;

# Streaming responses (exports, label PDFs) must not be buffered to disk.
proxy_buffering off;
proxy_request_buffering on;
