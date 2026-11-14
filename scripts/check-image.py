"""One image call through local Flask; never reads or prints the API key."""
import argparse
from pathlib import Path
import sys
import requests

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('image', type=Path)
args = parser.parse_args()
base = 'http://127.0.0.1:5001/vision'
token = None
try:
  response = requests.post(base + '/sessions', json={'kind': 'check'}, timeout=10)
  data = response.json()
  if not response.ok:
    sys.exit(data.get('error', 'Cannot create image check session.'))
  token = data['session']
  with args.image.open('rb') as image:
    response = requests.post(base + '/recognize', data={'session': token},
      files={'image': (args.image.name, image)}, timeout=40)
  data = response.json()
  if not response.ok:
    sys.exit(data.get('error', 'Image check failed.'))
  print('Objects:', ', '.join(f"{item['label']} {item['box_2d']}" for item in data['objects']) or '(none)')
  print('App attempts today:', data['usage']['appDailyAttempts'])
  print('Single-image check passed. Camera page is unlocked.')
except (requests.RequestException, OSError, ValueError):
  sys.exit('Could not check the image. Check the file and local Flask server.')
finally:
  if token:
    try:
      requests.post(base + '/sessions/' + token + '/stop', timeout=5)
    except requests.RequestException:
      pass
