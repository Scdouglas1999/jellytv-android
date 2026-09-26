#!/usr/bin/env python3
"""
A fake LG TV in Developer Mode, for trying Tally for LG end to end without a TV. Needs paramiko 3.x
(pip install "paramiko<4": 4 and later dropped ssh-rsa, the only algorithm a webOS TV's SSH offers).

  python3 fake-webos-tv.py --root /tmp/fake-tv [--ssh-port 9922] [--key-port 9991] [--passphrase 78DB5E]

What it does, as a webOS TV's Developer Mode does (LG's CLI @webos-tools/cli and webosbrew's tools read as the
specification, see ARCHITECTURE.md §11):
  - Key Server: GET http://<host>:<key-port>/webos_rsa answers the TV's private key, a traditional encrypted PEM
    (ssh-keygen -t rsa -m PEM -N <passphrase>, as the TV's start-devmode.sh makes it);
  - SSH on <ssh-port>: user "prisoner", that key only, a legacy ssh-rsa host key; exec and SFTP, with the TV's paths
    (/media/developer/..., /var/luna/preferences/devmode_enabled) kept under --root;
  - /usr/bin/luna-send-pub: getSystemInfo (a 2020 OLED, webOS 5.2), appInstallService/dev/install (the .ipk is
    really unpacked, ar + tar as opkg does, into /media/developer/apps/usr/palm/applications/<id>; its replies are a
    real TV's: statusValue 35 "ipk parsing", 36 "installing", 30 "installed"), applicationManager/launch,
    dev/closeByAppId, dev/listApps; tail -c | md5sum, test -d || mkdir -p, rm -f, cat.
Every command is printed (the transcript for the report). Stop it with Ctrl+C.
"""
import argparse
import hashlib
import http.server
import io
import json
import os
import shlex
import socket
import subprocess
import tarfile
import threading
import time

import paramiko
import logging

p = argparse.ArgumentParser()
p.add_argument('--root', required=True)
p.add_argument('--ssh-port', type=int, default=9922)
p.add_argument('--key-port', type=int, default=9991)
p.add_argument('--passphrase', default='78DB5E')
p.add_argument('--token', default='4a2f9c8e71d3b6055e0c1a9f8d7b6e5c')
p.add_argument('--model', default='OLED55CX9LA')
p.add_argument('--sdk', default='5.2.0')
args = p.parse_args()
if os.environ.get('FAKE_TV_DEBUG'):
    logging.basicConfig(level=logging.DEBUG)

ROOT = os.path.abspath(args.root)
os.makedirs(ROOT, exist_ok=True)
key_path = os.path.join(ROOT, 'webos_rsa')
if not os.path.exists(key_path):
    subprocess.run(['ssh-keygen', '-q', '-t', 'rsa', '-b', '2048', '-m', 'PEM', '-N', args.passphrase, '-C', 'developer@device', '-f', key_path], check=True)
client_key = paramiko.RSAKey.from_private_key_file(key_path, password=args.passphrase)
host_key = paramiko.RSAKey.generate(2048)
os.makedirs(os.path.join(ROOT, 'var/luna/preferences'), exist_ok=True)
with open(os.path.join(ROOT, 'var/luna/preferences/devmode_enabled'), 'w') as f:
    f.write(args.token)
os.makedirs(os.path.join(ROOT, 'media/developer'), exist_ok=True)
launched = []


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def local(path):
    return os.path.join(ROOT, path.lstrip('/'))


# ---- the key server ----
class KeyServer(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/webos_rsa':
            self.send_error(404)
            return
        body = open(key_path, 'rb').read()
        log('key server: GET /webos_rsa ->', len(body), 'bytes')
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


threading.Thread(target=http.server.ThreadingHTTPServer(('0.0.0.0', args.key_port), KeyServer).serve_forever, daemon=True).start()


# ---- the TV's services ----
def unpack_ipk(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'!<arch>\n', 'not an ar archive'
    at, members = 8, {}
    while at < len(data):
        h = data[at:at + 60].decode('ascii')
        name, size = h[:16].strip(), int(h[48:58])
        members[name] = data[at + 60:at + 60 + size]
        at += 60 + size + (size % 2)
    assert list(members) == ['debian-binary', 'control.tar.gz', 'data.tar.gz'], list(members)
    assert members['debian-binary'] == b'2.0\n'
    control = tarfile.open(fileobj=io.BytesIO(members['control.tar.gz'])).extractfile('control').read().decode()
    fields = dict(line.split(': ', 1) for line in control.strip().split('\n'))
    dest = local('/media/developer/apps')
    with tarfile.open(fileobj=io.BytesIO(members['data.tar.gz'])) as t:
        t.extractall(dest, filter='data')
    info = json.load(open(os.path.join(dest, 'usr/palm/packages', fields['Package'], 'packageinfo.json')))
    appinfo = json.load(open(os.path.join(dest, 'usr/palm/applications', info['app'], 'appinfo.json')))
    assert appinfo['id'] == fields['Package'] and appinfo['version'] == fields['Version']
    return fields['Package']


def luna(uri, params, out):
    if uri.endswith('/getSystemInfo'):
        out({'modelName': args.model, 'sdkVersion': args.sdk, 'firmwareVersion': '04.20.55', 'boardType': 'K7LP_DVB', 'otaId': 'HE_DTV_W20P_AFADABAA', 'returnValue': True})
    elif uri.endswith('/dev/install'):
        path = local(params['ipkUrl'])
        if not os.path.exists(path):
            out({'returnValue': False, 'errorCode': -2, 'errorText': 'invalid ipkUrl'})
            return
        out({'subscribed': True, 'returnValue': True})
        out({'id': params['id'], 'statusValue': 35, 'details': {'installBasePath': '/media/developer', 'simpleStatus': 'install', 'state': 'ipk parsing'}, 'returnValue': True})
        time.sleep(0.3)
        try:
            pkg = unpack_ipk(path)
        except Exception as e:  # noqa: BLE001
            out({'id': params['id'], 'statusValue': 24, 'details': {'errorCode': -3, 'reason': 'failed to extract ipk file: %s' % e, 'state': 'install failed'}, 'returnValue': True})
            return
        out({'id': params['id'], 'statusValue': 36, 'details': {'packageId': pkg, 'state': 'installing'}, 'returnValue': True})
        time.sleep(0.3)
        out({'id': params['id'], 'statusValue': 30, 'details': {'packageId': pkg, 'state': 'installed', 'simpleStatus': 'install'}, 'returnValue': True})
        # a subscription stays open until the client closes it
        time.sleep(30)
    elif uri.endswith('/launch'):
        launched.append(params['id'])
        out({'returnValue': True, 'processId': '1003'})
    elif uri.endswith('/dev/closeByAppId'):
        out({'returnValue': False, 'errorCode': -1, 'errorText': 'app is not running'})
    elif uri.endswith('/dev/listApps'):
        apps_dir = local('/media/developer/apps/usr/palm/applications')
        out({'apps': [{'id': a} for a in sorted(os.listdir(apps_dir))] if os.path.isdir(apps_dir) else [], 'returnValue': True})
    else:
        out({'returnValue': False, 'errorCode': -1, 'errorText': 'Unknown method'})


def run(command, channel):
    log('ssh exec:', command if len(command) < 300 else command[:300] + '…')
    def out(obj):
        channel.sendall((json.dumps(obj, separators=(',', ':')) + '\n').encode())
    parts = shlex.split(command.replace('|', ' | ').replace('||', ' || '))
    if parts[0] == '/usr/bin/luna-send-pub':
        i = 1
        while parts[i].startswith('-'):
            i += 2 if parts[i] == '-n' else 1
        luna(parts[i], json.loads(parts[i + 1]), out)
        return 0
    if parts[0] == '/usr/bin/test' and parts[1] == '-d':
        os.makedirs(local(parts[2]), exist_ok=True)
        return 0
    if parts[0] == '/usr/bin/tail':
        data = open(local(parts[3]), 'rb').read()[-int(parts[2]):]
        channel.sendall((hashlib.md5(data).hexdigest() + '  -\n').encode())
        return 0
    if parts[:2] == ['/bin/rm', '-f']:
        for f in parts[2:]:
            if os.path.exists(local(f)):
                os.remove(local(f))
        return 0
    if parts[0] == '/bin/cat' and len(parts) >= 2 and parts[1] != '>':
        try:
            channel.sendall(open(local(parts[1]), 'rb').read())
            return 0
        except OSError:
            return 1
    channel.sendall_stderr(('sh: %s: not found\n' % parts[0]).encode())
    return 127


class Server(paramiko.ServerInterface):
    def check_auth_publickey(self, username, key):
        ok = username == 'prisoner' and key.get_base64() == client_key.get_base64()
        log('ssh auth', username, 'publickey', 'accepted' if ok else 'refused')
        return paramiko.AUTH_SUCCESSFUL if ok else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return 'publickey'

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        def go():
            try:
                code = run(command.decode(), channel)
            except Exception as e:  # noqa: BLE001
                log('ssh exec failed:', e)
                code = 1
            try:
                channel.send_exit_status(code)
                channel.close()
            except Exception:  # noqa: BLE001
                pass
        threading.Thread(target=go, daemon=True).start()
        return True

    def check_channel_subsystem_request(self, channel, name):
        log('ssh subsystem', name)
        return super().check_channel_subsystem_request(channel, name)


class Handle(paramiko.SFTPHandle):
    def stat(self):
        return paramiko.SFTPAttributes.from_stat(os.fstat(self.readfile.fileno() if hasattr(self, 'readfile') else self.writefile.fileno()))


class Sftp(paramiko.SFTPServerInterface):
    def open(self, path, flags, attr):
        log('sftp open', path, 'write' if flags & (os.O_WRONLY | os.O_RDWR) else 'read')
        mode = 'wb' if flags & (os.O_WRONLY | os.O_RDWR) else 'rb'
        try:
            os.makedirs(os.path.dirname(local(path)), exist_ok=True) if 'w' in mode else None
            f = open(local(path), mode)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        h = Handle(flags)
        if 'w' in mode:
            h.writefile = f
        else:
            h.readfile = f
        h.filename = path
        return h

    def stat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(os.stat(local(path)))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    lstat = stat

    def canonicalize(self, path):
        return os.path.normpath('/' + path) if not path.startswith('/') else os.path.normpath(path)


sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(('0.0.0.0', args.ssh_port))
sock.listen(5)
log('fake LG TV: SSH on %d (prisoner), Key Server on %d, passphrase %s, root %s' % (args.ssh_port, args.key_port, args.passphrase, ROOT))
while True:
    conn, addr = sock.accept()
    t = paramiko.Transport(conn)
    # as a webOS TV: legacy ssh-rsa only (host key and user key signatures), the key exchanges LG's CLI offers it
    # (@webos-tools/cli novacom.js: group1-sha1, ecdh-nistp256/384/521, group-exchange-sha256, group14-sha1)
    t._preferred_keys = ('ssh-rsa',)
    t._preferred_pubkeys = ('ssh-rsa',)
    t._preferred_kex = ('ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521', 'diffie-hellman-group-exchange-sha256',
                        'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1')
    t.add_server_key(host_key)
    t.set_subsystem_handler('sftp', paramiko.SFTPServer, Sftp)
    t.start_server(server=Server())
