import { execFileSync, spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const config = resolve('os/config-pkg')
const read = (path: string): Promise<string> => readFile(join(config, path), 'utf8')
const firewallPath = join(config, 'etc/mediaos/firewall.nft')
const nftAvailable = spawnSync('nft', ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0

describe('OS hardening', () => {
  it('blocks Chrome bypasses without overriding the app proxy or enabling developer tools', async () => {
    const policy: Record<string, unknown> = JSON.parse(await read('etc/opt/chrome/policies/managed/mediaos.json'))
    // Chrome's policy is WebRtcIPHandling; an unknown key (such as WebRtcIPHandlingPolicy) is silently ignored.
    expect(policy.WebRtcIPHandling).toBe('disable_non_proxied_udp')
    expect(policy).not.toHaveProperty('WebRtcIPHandlingPolicy')
    expect(policy.DnsOverHttpsMode).toBe('off')
    expect(policy.ExtensionInstallBlocklist).toEqual(['*'])
    expect(Object.keys(policy).filter((key) => key.startsWith('Proxy'))).toEqual([])
    expect(policy.DeveloperToolsAvailability).toBe(2)
  })

  it('restricts files created by the shell to the session user', async () => {
    const unit = await read('usr/lib/systemd/user/mediaos-shell.service')
    expect(unit).toMatch(/\[Service\]\n(?:(?!\[)[^\n]*\n)*UMask=0077\n/)
  })

  it('replaces only its own firewall table and drops new tunnel connections', async () => {
    const rules = await read('etc/mediaos/firewall.nft')
    expect(rules).toContain('table inet mediaos\ndelete table inet mediaos\ntable inet mediaos {')
    expect(rules).toContain('iifname "mosvpn*" ct state new drop')
    expect(rules).toContain('type filter hook input priority 0; policy accept;')
    expect(rules).not.toMatch(/flush (?:ruleset|table)/)
    await expect(stat(join(config, 'etc/nftables.conf'))).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('depends on nftables and enables its own unit for the next boot before networking', async () => {
    const control = await read('DEBIAN/control')
    const depends = control.match(/^Depends: (?:[^\n]|\n )*/m)?.[0]
    expect(depends?.split(/,\s*/)).toContain('nftables')
    const unit = await read('usr/lib/systemd/system/mediaos-firewall.service')
    for (const line of ['DefaultDependencies=no', 'Wants=network-pre.target', 'Before=network-pre.target',
      'After=local-fs.target', 'Type=oneshot', 'RemainAfterExit=yes',
      'ExecStart=/usr/sbin/nft -f /etc/mediaos/firewall.nft', 'WantedBy=multi-user.target']) {
      expect(unit.split('\n')).toContain(line)
    }
    const postinst = await read('DEBIAN/postinst')
    const commands = postinst.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
    expect(commands).toMatch(/if \[ "\$1" = "configure" \]; then[\s\S]*systemctl enable mediaos-firewall\.service[\s\S]*fi/)
    expect(commands).not.toMatch(/\b(?:start|restart|try-restart|reload-or-restart|--now)\b/)
    expect(commands).not.toMatch(/systemctl[^\n]*\bnftables\.service\b/)
  })

  it.skipIf(!nftAvailable)('validates the firewall with nft without applying it', () => {
    expect(() => execFileSync('nft', ['-c', '-f', firewallPath], { encoding: 'utf8', timeout: 5000 })).not.toThrow()
  })
})
