"""Save a Gemini key locally without displaying it or putting it in shell history."""
from getpass import getpass
from pathlib import Path
import os
import tempfile

from dotenv import dotenv_values


def main():
  target = Path(__file__).resolve().parent.parent / 'sdow' / '.env.local'
  print('Use the key from your existing free-tier Gemini project.')
  print('Pasting will be invisible. No API request will be made.')
  try:
    key = getpass('Paste your Gemini API key, then press Return: ').strip()
  except (KeyboardInterrupt, EOFError):
    print('\nCancelled; configuration was not changed.')
    return
  if not key or any(character.isspace() for character in key) or "'" in key or '"' in key:
    print('No valid key entered; configuration was not changed.')
    return
  values = dotenv_values(target) if target.exists() else {}
  model = values.get('GEMINI_MODEL') or 'gemini-3.1-flash-lite'
  # Replace just these settings, preserving any other local configuration.
  lines = target.read_text().splitlines() if target.exists() else []
  lines = [line for line in lines if not line.strip().startswith(
      ('GEMINI_API_KEY=', 'GEMINI_MODEL=', 'export GEMINI_API_KEY=', 'export GEMINI_MODEL='))]
  lines.extend([f'GEMINI_API_KEY={key}', f'GEMINI_MODEL={model}'])
  descriptor, temporary = tempfile.mkstemp(dir=target.parent, prefix='.gemini-setup-')
  try:
    with os.fdopen(descriptor, 'w') as file:
      file.write('\n'.join(lines) + '\n')
    os.replace(temporary, target)
  finally:
    if os.path.exists(temporary):
      os.unlink(temporary)
  print('Key saved privately. Open http://127.0.0.1:3000/camera and click Check one image.')


if __name__ == '__main__':
  main()
