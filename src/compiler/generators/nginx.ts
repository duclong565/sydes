export function generateNginx(upstreams: string[]): string {
  const servers = upstreams.map((u) => `    server ${u}:8080;`).join('\n');
  return [
    'upstream backend {',
    servers,
    '}',
    '',
    'server {',
    '    listen 80;',
    '    client_max_body_size 2m;',
    '    location / {',
    '        proxy_pass http://backend;',
    '    }',
    '}',
    '',
  ].join('\n');
}
