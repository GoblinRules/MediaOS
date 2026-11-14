import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const config = resolve('os/config-pkg')
const script = join(config, 'usr/libexec/mediaos/net-handover')
const fixtureDir = resolve('test/fixtures/os')
const uuid = '12345678-1234-5678-9abc-123456789abc'
const interfacesPath = 'etc/network/interfaces'
const connectionsPath = 'etc/NetworkManager/system-connections'
const markerPath = 'var/lib/mediaos/net-handover.done'
const keyfile = `[connection]
id=MediaOS wired
uuid=${uuid}
type=ethernet
autoconnect=true
autoconnect-priority=10
[ethernet]
[ipv4]
method=auto
dhcp-client-id=mac
[ipv6]
method=auto
`

function findSh(): string | undefined {
  const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'sh'] : ['sh']
  return candidates.find((candidate) => {
    try {
      execFileSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore', timeout: 5000 })
      return true
    } catch { return false }
  })
}

const sh = findSh()
const shellPath = (path: string): string => path.replaceAll('\\', '/')
const fixture = (name: string): Promise<string> => readFile(join(fixtureDir, name), 'utf8')

describe.skipIf(!sh)('network hand-over (POSIX sh)', () => {
  let root: string
  const path = (relative: string): string => join(root, relative)
  const read = (relative: string): Promise<string> => readFile(path(relative), 'utf8')
  const exists = async (relative: string): Promise<boolean> => {
    try { await stat(path(relative)); return true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  async function put(relative: string, text: string): Promise<void> {
    await mkdir(dirname(path(relative)), { recursive: true })
    await writeFile(path(relative), text, 'utf8')
  }
  function run(override: string | null = uuid) {
    const env: NodeJS.ProcessEnv = { ...process.env, MEDIAOS_ROOT: '.' }
    // Do not inherit the testing override when exercising the kernel UUID source.
    delete env.MEDIAOS_UUID
    if (override !== null) env.MEDIAOS_UUID = override
    // Relative paths keep Git sh from traversing restricted Windows home folders with mkdir -p.
    return exec(sh!, [shellPath(script)], { cwd: root, env, timeout: 10_000 })
  }

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), '.net-handover root-')) })
  afterEach(async () => {
    // Only remove the exact temporary root created by this suite.
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('.net-handover root-')) {
      throw new Error('Unexpected temporary root')
    }
    await rm(root, { recursive: true, force: true })
  })

  it('hands over a fresh Debian 13 cable install, preserving loopback and source lines', async () => {
    const original = await fixture('interfaces-debian13')
    await put(interfacesPath, original)
    const { stdout } = await run()
    const result = await read(interfacesPath)
    expect(result.split('\n').filter((line) => line && !line.startsWith('#'))).toEqual([
      'source /etc/network/interfaces.d/*', 'auto lo', 'iface lo inet loopback',
    ])
    for (const line of ['allow-hotplug ens160', 'iface ens160 inet dhcp', 'iface ens160 inet6 auto', '    accept_ra 1']) {
      expect(result).toContain(`#mediaos# ${line}\n`)
    }
    expect(await read(`${interfacesPath}.mediaos-bak`)).toBe(original)
    expect(await read(`${connectionsPath}/mediaos-wired.nmconnection`)).toBe(keyfile)
    if (process.platform !== 'win32') {
      expect((await stat(path(`${connectionsPath}/mediaos-wired.nmconnection`))).mode & 0o777).toBe(0o600)
    }
    expect(await exists(markerPath)).toBe(true)
    expect(stdout).toContain('Handed cable interfaces to NetworkManager.')
    expect(await readdir(path('etc/network'))).toEqual(['interfaces', 'interfaces.mediaos-bak'])
    expect(await readdir(path(connectionsPath))).toEqual(['mediaos-wired.nmconnection'])
  })

  it('leaves the already handed-over VM files byte-identical and recognises a differently named keyfile', async () => {
    const original = await fixture('interfaces-handed-over')
    const existing = `${keyfile}# Keep the VM profile.\n`
    await put(interfacesPath, original)
    await put(`${connectionsPath}/MediaOS wired.nmconnection`, existing)
    const before = await stat(path(interfacesPath))
    await run('not-a-uuid') // An existing profile never needs a new UUID.
    expect(await read(interfacesPath)).toBe(original)
    expect((await stat(path(interfacesPath))).mtimeMs).toBe(before.mtimeMs)
    expect(await exists(`${interfacesPath}.mediaos-bak`)).toBe(false)
    expect(await readdir(path(connectionsPath))).toEqual(['MediaOS wired.nmconnection'])
    expect(await read(`${connectionsPath}/MediaOS wired.nmconnection`)).toBe(existing)
    expect(await exists(markerPath)).toBe(true)
  })

  it.each(['wpa-ssid', 'wpa-conf', 'wireless-essid'])('leaves Wi-Fi with %s untouched while commenting the cable', async (option) => {
    const original = (await fixture('interfaces-wifi')).replace('wpa-ssid', option)
    await put(interfacesPath, original)
    const { stdout } = await run()
    const expected = original.split('\n').map((line) => {
      return /^(allow-hotplug eth0|iface eth0| {4}(address|gateway))/.test(line) ? `#mediaos# ${line}` : line
    }).join('\n')
    expect(await read(interfacesPath)).toBe(expected)
    expect(stdout.split('\n').filter((line) => line.includes('Wi-Fi'))).toEqual([
      'Leaving Wi-Fi interface wlan0 with ifupdown.',
    ])
    expect(await exists(markerPath)).toBe(true)
  })

  it.each(['auto', 'allow-hotplug', 'allow-custom'])('keeps loopback active in a mixed %s lo eth0 line', async (directive) => {
    await put(interfacesPath, `${directive} lo eth0\niface lo inet loopback\niface eth0 inet dhcp\n`)
    await run()
    expect(await read(interfacesPath)).toBe(
      `${directive} lo\n#mediaos# ${directive} lo eth0\niface lo inet loopback\n#mediaos# iface eth0 inet dhcp\n`,
    )
  })

  it.each(['auto', 'allow-hotplug', 'allow-custom'])('splits mixed %s lines and preserves safe activation lines exactly',
    async (directive) => {
      const original = `${directive} wlan0 eth0 lo wlan1 # mixed\n` +
        `  ${directive} wlan1 lo wlan0 # safe\n` +
        'iface wlan0 inet dhcp\nwpa-conf /etc/wpa.conf\n' +
        'iface wlan1 inet dhcp\nwireless-essid Guest\niface eth0 inet dhcp\n'
      await put(interfacesPath, original)
      await run()
      expect(await read(interfacesPath)).toBe(
        `${directive} wlan0 lo wlan1\n#mediaos# ${directive} wlan0 eth0 lo wlan1 # mixed\n` +
        `  ${directive} wlan1 lo wlan0 # safe\n` +
        'iface wlan0 inet dhcp\nwpa-conf /etc/wpa.conf\n' +
        'iface wlan1 inet dhcp\nwireless-essid Guest\n#mediaos# iface eth0 inet dhcp\n',
      )
    })

  it.each(['wpa-ssid', 'wpa-conf', 'wireless-essid'])('parses unindented options and indented stanza headers with %s',
    async (option) => {
      const original = 'iface lo inet loopback\n  iface eth0 inet static\naddress 192.0.2.2/24\n' +
        '# comment\n\ngateway 192.0.2.1\n  mapping map0\nscript /etc/map\nwpa-ssid not-an-iface\n' +
        `  iface wlan0 inet dhcp\naddress 192.0.2.3/24\n${option} Home\n` +
        '  auto lo wlan0 eth0\n  source /etc/network/interfaces.d/*\nkeep-source-option yes\n' +
        '  allow-custom eth1\nkeep-activation-option yes\n  iface eth1 inet dhcp\nmetric 100\n'
      await put(interfacesPath, original)
      await run()
      expect(await read(interfacesPath)).toBe(original
        .replace('  iface eth0', '#mediaos#   iface eth0')
        .replace('address 192.0.2.2/24', '#mediaos# address 192.0.2.2/24')
        .replace('gateway 192.0.2.1', '#mediaos# gateway 192.0.2.1')
        .replace('  auto lo wlan0 eth0', 'auto lo wlan0\n#mediaos#   auto lo wlan0 eth0')
        .replace('  allow-custom eth1', '#mediaos#   allow-custom eth1')
        .replace('  iface eth1', '#mediaos#   iface eth1')
        .replace('metric 100', '#mediaos# metric 100'))
    })

  it('discovers Wi-Fi across include files and keeps backups and temporary files outside the source glob', async () => {
    const main = 'source /etc/network/interfaces.d/*\nauto lo wlan0 eth0\niface lo inet loopback\n'
    const wifi = 'iface wlan0 inet dhcp\nwpa-conf /etc/wpa.conf\n'
    const cable = 'allow-custom eth0 wlan0\niface eth0 inet static\naddress 192.0.2.2/24\n'
    await put(interfacesPath, main)
    await put('etc/network/interfaces.d/wifi config', wifi)
    await put('etc/network/interfaces.d/cable.cfg', cable)
    await put('etc/network/interfaces.d/.hidden', 'iface hidden inet dhcp\n')
    await mkdir(path('etc/network/interfaces.d/subfolder'))
    await put('var/lib/mediaos/ifupdown-backup/cable.cfg', 'older backup\n')
    await run()
    const handedOver = 'allow-custom wlan0\n#mediaos# allow-custom eth0 wlan0\n' +
      '#mediaos# iface eth0 inet static\n#mediaos# address 192.0.2.2/24\n'
    expect(await read(interfacesPath)).toBe(main.replace('auto lo wlan0 eth0', 'auto lo wlan0\n#mediaos# auto lo wlan0 eth0'))
    expect(await read('etc/network/interfaces.d/cable.cfg')).toBe(handedOver)
    expect(await read('etc/network/interfaces.d/wifi config')).toBe(wifi)
    expect(await read('etc/network/interfaces.d/.hidden')).toBe('iface hidden inet dhcp\n')
    expect(await read('var/lib/mediaos/ifupdown-backup/cable.cfg')).toBe('older backup\n')
    expect(await exists('var/lib/mediaos/ifupdown-backup/wifi config')).toBe(false)
    expect(await readdir(path('etc/network/interfaces.d'))).toEqual(['.hidden', 'cable.cfg', 'subfolder', 'wifi config'])
    await run()
    expect(await read('etc/network/interfaces.d/cable.cfg')).toBe(handedOver)
    expect(await read(`${interfacesPath}.mediaos-bak`)).toBe(main)
  })

  it('handles include files without a main file and backs them up outside interfaces.d', async () => {
    const original = 'auto eth0\niface eth0 inet dhcp\n'
    await put('etc/network/interfaces.d/cable', original)
    await run()
    expect(await read('var/lib/mediaos/ifupdown-backup/cable')).toBe(original)
    expect(await read('etc/network/interfaces.d/cable')).toBe('#mediaos# auto eth0\n#mediaos# iface eth0 inet dhcp\n')
    expect(await readdir(path('etc/network/interfaces.d'))).toEqual(['cable'])
  })

  it('logs other include paths without following them', async () => {
    const main = 'source /etc/network/other/*\n  source-directory /etc/other\n'
    await put(interfacesPath, main)
    await put('etc/network/other/cable', 'iface eth0 inet dhcp\n')
    await put('etc/other/cable', 'iface eth1 inet dhcp\n')
    const { stdout } = await run()
    expect(stdout).toContain('not handed over: /etc/network/other/*\n')
    expect(stdout).toContain('not handed over: /etc/other\n')
    expect(await read(interfacesPath)).toBe(main)
    expect(await read('etc/network/other/cable')).toBe('iface eth0 inet dhcp\n')
    expect(await read('etc/other/cable')).toBe('iface eth1 inet dhcp\n')
  })

  it('retries an interrupted rewrite with a keyfile already in place and no marker', async () => {
    await put(interfacesPath, 'auto eth0\niface eth0 inet dhcp\n')
    await put('etc/network/interfaces.d/cable', 'iface eth1 inet dhcp\n')
    await put('var/lib/mediaos/ifupdown-backup', 'blocks backup directory\n')
    await expect(run()).rejects.toHaveProperty('code', 1)
    expect(await read(`${connectionsPath}/mediaos-wired.nmconnection`)).toBe(keyfile)
    expect(await read(interfacesPath)).toBe('#mediaos# auto eth0\n#mediaos# iface eth0 inet dhcp\n')
    expect(await read('etc/network/interfaces.d/cable')).toBe('iface eth1 inet dhcp\n')
    expect(await exists(markerPath)).toBe(false)
    expect(await readdir(path('etc/network/interfaces.d'))).toEqual(['cable'])
    await rm(path('var/lib/mediaos/ifupdown-backup'))
    await run()
    expect(await read('etc/network/interfaces.d/cable')).toBe('#mediaos# iface eth1 inet dhcp\n')
    expect(await exists(markerPath)).toBe(true)
  })

  it.each(['bad-uuid', `${uuid}\ninvalid`, `${uuid}0`, ''])('rejects an invalid UUID (%j) without a keyfile or marker', async (bad) => {
    const original = await fixture('interfaces-debian13')
    await put(interfacesPath, original)
    await put('etc/network/interfaces.d/cable', 'iface eth0 inet dhcp\n')
    await expect(run(bad)).rejects.toMatchObject({ code: 1 })
    expect(await read(interfacesPath)).toBe(original)
    expect(await read('etc/network/interfaces.d/cable')).toBe('iface eth0 inet dhcp\n')
    expect(await exists(`${interfacesPath}.mediaos-bak`)).toBe(false)
    expect(await readdir(path(connectionsPath))).toEqual([])
    expect(await exists(markerPath)).toBe(false)
  })

  it('reads the kernel UUID through MEDIAOS_ROOT when no override is set and interfaces is missing', async () => {
    await put('proc/sys/kernel/random/uuid', `${uuid}\n`)
    await run(null)
    expect(await read(`${connectionsPath}/mediaos-wired.nmconnection`)).toBe(keyfile)
    expect(await exists(markerPath)).toBe(true)
    expect(await exists(interfacesPath)).toBe(false)
  })

  it('retries after a missing UUID source without overwriting an older backup', async () => {
    await put(interfacesPath, await fixture('interfaces-debian13'))
    await put(`${interfacesPath}.mediaos-bak`, 'older backup\n')
    await expect(run(null)).rejects.toHaveProperty('code', 1)
    expect(await exists(markerPath)).toBe(false)
    expect(await read(interfacesPath)).toBe(await fixture('interfaces-debian13'))
    await run()
    expect(await read(interfacesPath)).toContain('#mediaos# iface ens160 inet dhcp')
    expect(await read(`${interfacesPath}.mediaos-bak`)).toBe('older backup\n')
    expect(await exists(markerPath)).toBe(true)
  })
})

it('orders the one-shot hand-over before both network services and only enables it during configure', async () => {
  const unit = await readFile(join(config, 'usr/lib/systemd/system/mediaos-net-handover.service'), 'utf8')
  expect(unit.split('\n')).toEqual([
    '[Unit]', 'Description=Hand cable interfaces to NetworkManager', 'DefaultDependencies=no', 'After=local-fs.target',
    'Before=networking.service NetworkManager.service network-pre.target', 'Wants=network-pre.target',
    'ConditionPathExists=!/var/lib/mediaos/net-handover.done', '', '[Service]', 'Type=oneshot',
    'ExecStart=/usr/libexec/mediaos/net-handover', '', '[Install]', 'WantedBy=sysinit.target', '',
  ])
  const postinst = await readFile(join(config, 'DEBIAN/postinst'), 'utf8')
  expect(postinst).toMatch(/if \[ "\$1" = "configure" \]; then[\s\S]*systemctl enable mediaos-net-handover\.service[\s\S]*fi/)
  const commands = postinst.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
  expect(commands).not.toMatch(/\b(?:start|restart|try-restart|reload-or-restart|--now)\b/)
  expect(commands).not.toContain('NetworkManager')
  expect(unit).not.toContain('MEDIAOS_ROOT')
  expect(unit).not.toContain('MEDIAOS_UUID')
})

it('grants exactly the seven NetworkManager actions and retains the six login1 actions for mediaos', async () => {
  const rules = await readFile(join(config, 'etc/polkit-1/rules.d/50-mediaos.rules'), 'utf8')
  const nm = ['network-control', 'enable-disable-network', 'enable-disable-wifi', 'wifi.scan',
    'settings.modify.system', 'settings.modify.own', 'checkpoint-rollback']
  const login = ['reboot', 'reboot-multiple-sessions', 'power-off', 'power-off-multiple-sessions', 'suspend', 'suspend-multiple-sessions']
  const array = rules.match(/var nm = \[([\s\S]*?)\];/)
  expect(array?.[1]?.match(/"([^"]+)"/g)?.map((value) => value.slice(1, -1))).toEqual(nm)
  expect(rules).not.toMatch(/subject\.(?:local|active)|\b(?:let|const)\b|=>/)
  expect(rules).toContain('settings.modify.global-dns')
  type Rule = (action: { id: string }, subject: { user: string }) => string
  let rule: Rule | undefined
  runInNewContext(rules, { polkit: {
    addRule: (callback: Rule) => { rule = callback }, Result: { YES: 'yes', NOT_HANDLED: 'unhandled' },
  } })
  for (const id of nm.map((action) => `org.freedesktop.NetworkManager.${action}`)
    .concat(login.map((action) => `org.freedesktop.login1.${action}`))) {
    expect(rule!({ id }, { user: 'mediaos' })).toBe('yes')
    expect(rule!({ id }, { user: 'another-user' })).toBe('unhandled')
  }
  for (const action of ['settings.modify.global-dns', 'settings.modify.system.extra', 'reload', 'anything']) {
    expect(rule!({ id: `org.freedesktop.NetworkManager.${action}` }, { user: 'mediaos' })).toBe('unhandled')
  }
  expect(rules.match(/"org\.freedesktop\.login1\.[^"]+"/g)).toHaveLength(6)
  expect(rule!({ id: 'org.freedesktop.timedate1.set-timezone' }, { user: 'mediaos' })).toBe('yes')
  expect(rule!({ id: 'org.freedesktop.timedate1.set-time' }, { user: 'mediaos' })).toBe('unhandled')
  expect(rule!({ id: 'org.freedesktop.timedate1.set-timezone' }, { user: 'another-user' })).toBe('unhandled')
})

it('lets NetworkManager write DNS settings to resolv.conf and enables real networking for the shell', async () => {
  const nm = await readFile(join(config, 'etc/NetworkManager/conf.d/50-mediaos.conf'), 'utf8')
  expect(nm.split('\n').filter((line) => !line.startsWith('#')).join('\n')).toBe('[main]\ndns=default\nrc-manager=file\n')
  expect(nm.split('\n').filter((line) => line.startsWith('#'))).toHaveLength(2)
  const service = await readFile(join(config, 'usr/lib/systemd/user/mediaos-shell.service'), 'utf8')
  expect(service).toContain('Environment=MEDIAOS_PLATFORM=linux\nEnvironment=MEDIAOS_REAL_SYSTEM=network,vpn\n')
  const build = await readFile(resolve('os/build/build-in-container.sh'), 'utf8')
  const chmod = build.replace(/\\\n\s*/g, '').split('\n').find((line) => line.startsWith('chmod 0755 '))
  expect(chmod).toContain('"$root/usr/libexec/mediaos/net-handover"')
})

it('stores all new files as UTF-8 without a BOM or CR characters', async () => {
  const paths = [script, join(config, 'usr/lib/systemd/system/mediaos-net-handover.service'),
    join(config, 'etc/NetworkManager/conf.d/50-mediaos.conf'), resolve('test/unit/net-handover.test.ts'),
    ...(await readdir(fixtureDir)).map((name) => join(fixtureDir, name))]
  for (const path of paths) {
    const content = await readFile(path, 'utf8')
    expect(content, path).not.toContain('\r')
    expect(content.startsWith('\uFEFF'), path).toBe(false)
  }
})
