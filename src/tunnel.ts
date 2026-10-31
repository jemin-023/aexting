import { networkInterfaces, homedir } from 'node:os';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { startTunnel as untunStart } from 'untun';

export interface TunnelOptions {
  port: number;
  tunnelToken?: string;
  publicUrl?: string;
}

export interface TunnelResult {
  url: string;
  close: () => Promise<void>;
  type: 'cloudflared-cli' | 'cloudflared-token' | 'untun' | 'custom';
}

export function getLanIps(): string[] {
  const nets = networkInterfaces();
  const ips: string[] = [];

  for (const name of Object.keys(nets)) {
    const net = nets[name];
    if (!net) continue;
    for (const item of net) {
      if (item.family === 'IPv4' && !item.internal) {
        ips.push(item.address);
      }
    }
  }

  return ips;
}

function findCloudflaredBinary(): string | null {
  const home = homedir();
  const candidates = [
    'cloudflared',
    path.join(home, '.local/bin/cloudflared'),
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    path.join(process.cwd(), 'bin/cloudflared'),
  ];

  for (const p of candidates) {
    if (p === 'cloudflared') {
      try {
        const check = spawn('cloudflared', ['--version']);
        check.on('error', () => {});
        return 'cloudflared';
      } catch {
        // not on path
      }
    } else if (existsSync(p)) {
      return p;
    }
  }

  return null;
}

export async function createPublicTunnel(options: TunnelOptions): Promise<TunnelResult | null> {
  const { port, tunnelToken, publicUrl } = options;

  // 1. Explicit Custom Public URL provided
  if (publicUrl) {
    return {
      url: publicUrl.replace(/\/+$/, ''),
      close: async () => {},
      type: 'custom',
    };
  }

  const binary = findCloudflaredBinary();

  // 2. Cloudflare Named Tunnel with Token (CLOUDFLARE_TUNNEL_TOKEN or --tunnel-token)
  const token = tunnelToken || process.env.CLOUDFLARE_TUNNEL_TOKEN;
  if (token && binary) {
    console.log(pc.cyan('⚡ Starting Cloudflare Named Tunnel using user-provided token...'));
    const proc = spawn(binary, ['tunnel', 'run', '--token', token], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return {
      url: process.env.AEXTING_PUBLIC_URL || 'https://cloudflare-named-tunnel.active',
      close: async () => {
        try {
          proc.kill('SIGTERM');
        } catch {}
      },
      type: 'cloudflared-token',
    };
  }

  // 3. Zero-Config Cloudflare Quick Tunnel via system cloudflared binary
  if (binary) {
    try {
      console.log(pc.cyan('⚡ Starting Cloudflare Quick Tunnel via cloudflared binary...'));
      const proc = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const tunnelUrl = await new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => {
          resolve(null);
        }, 12000);

        const checkOutput = (data: Buffer) => {
          const text = data.toString();
          // Look for: https://xxx.trycloudflare.com
          const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
          if (match) {
            clearTimeout(timeout);
            resolve(match[0]);
          }
        };

        proc.stdout?.on('data', checkOutput);
        proc.stderr?.on('data', checkOutput);

        proc.on('error', () => {
          clearTimeout(timeout);
          resolve(null);
        });

        proc.on('close', () => {
          clearTimeout(timeout);
          resolve(null);
        });
      });

      if (tunnelUrl) {
        return {
          url: tunnelUrl,
          close: async () => {
            try {
              proc.kill('SIGTERM');
            } catch {}
          },
          type: 'cloudflared-cli',
        };
      } else {
        proc.kill();
      }
    } catch {
      // fallback to untun
    }
  }

  // 4. Fallback to untun (Cloudflare Quick Tunnel via UnJS)
  try {
    console.log(pc.cyan('⚡ Starting Cloudflare Quick Tunnel via untun...'));
    const tunnel = await untunStart({
      port,
      acceptCloudflareNotice: true,
    });

    if (tunnel) {
      const url = await tunnel.getURL();
      return {
        url,
        close: async () => {
          try {
            await tunnel.close();
          } catch {}
        },
        type: 'untun',
      };
    }
  } catch (err: any) {
    console.warn(
      pc.yellow(`[Tunnel] Notice: Automatic quick tunnel not available: ${err?.message || err}`)
    );
  }

  console.log(
    pc.dim(
      '💡 Tip: Install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or pass --public-url for remote machine access.'
    )
  );

  return null;
}
