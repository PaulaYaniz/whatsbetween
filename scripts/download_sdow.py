#!/usr/bin/env python3
"""Download the pinned SDOW snapshot with a persisted transfer ceiling.

Run with env/bin/python. Reads gcloud's existing login, never prints credentials,
and leaves the active database untouched. Retransmitted ranges count in full
against the transfer ceiling, even if the network fails partway through.
"""
import base64
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time

import requests


ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / 'data' / 'sdow-20231220'
SOURCE = 'gs://sdow-prod/dumps/20231220/sdow.sqlite.gz'
PROJECT = 'wiki-wormhole'
MAX_TRANSFER = 5 * 1024**3
CHUNK = 64 * 1024**2


def cli(*args):
    executable = shutil.which('gcloud') or '/opt/homebrew/bin/gcloud'
    result = subprocess.run([executable, *args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Google Cloud command failed; check the CLI login and project access.')
    return result.stdout.strip()


def save(path, value):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.replace(path)


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    metadata = json.loads(cli('storage', 'objects', 'describe', SOURCE,
                              '--billing-project=' + PROJECT, '--format=json'))
    size = int(metadata['size'])
    if size > MAX_TRANSFER or metadata['storage_class'] != 'STANDARD':
        raise RuntimeError('File size or storage class differs from the approved download. Stopping.')
    save(DEST / 'object-metadata.json', metadata)
    ledger_path = DEST / 'transfer-ledger.json'
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {
        'project': PROJECT, 'generation': str(metadata['generation']),
        'reserved_transfer_bytes': 0, 'maximum_transfer_bytes': MAX_TRANSFER,
        'request_count': 0,
    }
    if ledger['generation'] != str(metadata['generation']):
        raise RuntimeError('The source object changed. Existing partial data was preserved.')
    save(DEST / 'download-status.json', {'source': SOURCE, 'snapshot': '2023-12-20',
         'status': 'downloading', 'maximum_transfer_bytes': MAX_TRANSFER,
         'active_database_replaced': False})
    archive = DEST / 'sdow.sqlite.gz'
    partial = DEST / 'sdow.sqlite.gz.part'
    session = requests.Session()
    session.headers['Authorization'] = 'Bearer ' + cli('auth', 'print-access-token')
    session.headers['Accept-Encoding'] = 'identity'
    url = 'https://storage.googleapis.com/download/storage/v1/b/sdow-prod/o/dumps%2F20231220%2Fsdow.sqlite.gz'
    params = {'alt': 'media', 'userProject': PROJECT, 'generation': metadata['generation']}
    if not archive.exists():
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > size:
            raise RuntimeError('Partial file is larger than the source. Stopping.')
        failures = 0
        while offset < size:
            end = min(size - 1, offset + CHUNK - 1)
            requested = end - offset + 1
            if ledger['reserved_transfer_bytes'] + requested > MAX_TRANSFER or ledger['request_count'] >= 100:
                raise RuntimeError('Transfer safety ceiling reached. Partial file preserved; no further charges requested.')
            ledger['reserved_transfer_bytes'] += requested
            ledger['request_count'] += 1
            save(ledger_path, ledger)
            try:
                with session.get(url, params=params, headers={'Range': f'bytes={offset}-{end}'},
                                 stream=True, timeout=(15, 45)) as response:
                    if response.status_code != 206 or response.headers.get('Content-Range') != f'bytes {offset}-{end}/{size}':
                        raise RuntimeError(f'Unexpected download response ({response.status_code}); download stopped.')
                    with partial.open('ab') as output:
                        for data in response.iter_content(1024**2):
                            if offset + len(data) > end + 1:
                                raise RuntimeError('Response exceeded requested range. Download stopped.')
                            output.write(data)
                            offset += len(data)
                if offset != end + 1:
                    raise requests.ConnectionError('Incomplete range')
                failures = 0
                print(f'Download {offset / size:.1%}: {offset:,} / {size:,} bytes', flush=True)
            except requests.RequestException:
                failures += 1
                if failures >= 3:
                    raise RuntimeError('Repeated network failures. Resume later; transfer ceiling remains in force.')
                offset = partial.stat().st_size
                print('Network interrupted; resuming within the existing transfer ceiling.', flush=True)
                time.sleep(2)
        partial.replace(archive)
    print('Verifying compressed file MD5...', flush=True)
    digest = hashlib.md5()
    with archive.open('rb') as source:
        for data in iter(lambda: source.read(8 * 1024**2), b''):
            digest.update(data)
    if archive.stat().st_size != size or base64.b64encode(digest.digest()).decode() != metadata['md5_hash']:
        raise RuntimeError('Checksum mismatch. Archive preserved for inspection and not activated.')
    print('Checksum matches the official object.', flush=True)
    database = DEST / 'sdow.sqlite'
    if not database.exists():
        print('Extracting and validating gzip locally...', flush=True)
        staging = DEST / 'sdow.sqlite.extracting'
        with gzip.open(archive, 'rb') as source, staging.open('wb') as output:
            shutil.copyfileobj(source, output, 8 * 1024**2)
        staging.replace(database)
    print('Checking SQLite integrity and real article coverage...', flush=True)
    connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    try:
        integrity = connection.execute('PRAGMA quick_check').fetchone()[0]
        if integrity != 'ok':
            raise RuntimeError('SQLite quick_check failed.')
        counts = {name: connection.execute(f'SELECT COUNT(*) FROM {name}').fetchone()[0]
                  for name in ['pages', 'links', 'redirects']}
        samples = connection.execute("SELECT id, title FROM pages WHERE title IN ('Coffee', 'Tea', 'Wikipedia')").fetchall()
        if counts['pages'] < 1_000_000 or len(samples) != 3:
            raise RuntimeError('Full-graph coverage check failed.')
    finally:
        connection.close()
    report = {'source': SOURCE, 'snapshot': '2023-12-20', 'status': 'downloaded_and_validated',
              'compressed_bytes': size, 'sqlite_bytes': database.stat().st_size,
              'md5_verified': True, 'sqlite_quick_check': integrity, 'counts': counts,
              'sample_articles': samples, 'reserved_transfer_bytes': ledger['reserved_transfer_bytes'],
              'active_database_replaced': False}
    save(DEST / 'download-status.json', report)
    print(json.dumps(report, indent=2), flush=True)


if __name__ == '__main__':
    main()
