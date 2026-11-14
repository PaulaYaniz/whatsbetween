import io
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock

from flask import Flask
from PIL import Image
from sdow.vision import VisionService, VisionError, create_blueprint, validate_result, generate


class VisionTests(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.now = 1000
    self.generator = Mock(return_value='{"objects":[{"label":"coin","box_2d":[100,200,400,600]}]}')
    self.service = VisionService(Path(self.tmp.name)/'usage.sqlite',
      config=lambda: ('test-key', 'gemini-3.1-flash-lite'), generator=self.generator,
      clock=lambda: self.now)
    self.session = self.service.session('check')
    out = io.BytesIO()
    Image.new('RGB', (100,100)).save(out, 'JPEG')
    self.image = out.getvalue()
    self.app = Flask(__name__)
    self.app.register_blueprint(create_blueprint(self.service))
    self.client = self.app.test_client()

  def tearDown(self):
    self.tmp.cleanup()

  def request(self):
    return self.client.post('/vision/recognize', data={'session': self.session,
      'image': (io.BytesIO(self.image), 'frame.jpg')})

  def test_single_image_before_camera(self):
    with self.assertRaises(VisionError):
      self.service.session('camera')
    response = self.request()
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.json['objects'], [{'label':'coin','box_2d':[100,200,400,600]}])
    self.assertEqual(response.json['usage']['appDailyAttempts'], 1)
    self.assertTrue(self.service.session('camera'))

  def test_missing_credentials(self):
    self.service.config = lambda: ('', 'gemini-3.1-flash-lite')
    self.assertEqual(self.request().json['code'], 'missing_credentials')
    self.generator.assert_not_called()

  def test_malformed_responses(self):
    for value in ('no json', '{}', '{"objects":[42]}', '{"objects":null}',
                  '{"objects":[],"confidence":90}', '[]'):
      self.generator.return_value = value
      response = self.request()
      self.assertEqual(response.json['code'], 'malformed_response')
      self.now += 12
      # Checks have a five/day ceiling; isolate each schema test's usage.
      with self.service.db() as c:
        c.execute('DELETE FROM attempts')
    self.assertFalse(self.service.status()['verified'])

  def test_quota_no_retry(self):
    error = RuntimeError('secret provider text')
    error.code = 429
    self.generator.side_effect = error
    self.assertEqual(self.request().json['code'], 'quota')
    self.now += 12
    self.assertEqual(self.request().json['code'], 'quota')
    self.assertEqual(self.generator.call_count, 1)

  def test_overlap_and_stop(self):
    entered, release = threading.Event(), threading.Event()
    def slow(*_):
      entered.set()
      release.wait(3)
      return '{"objects":[]}'
    self.service.generator = slow
    thread = threading.Thread(target=lambda: self.service.recognize(self.session, self.image))
    thread.start()
    self.assertTrue(entered.wait(2))
    self.assertEqual(self.request().json['code'], 'busy')
    self.service.stop(self.session)
    release.set()
    thread.join()
    self.now += 12
    self.assertEqual(self.request().json['code'], 'session_stopped')

  def test_persisted_limits(self):
    self.request()
    self.assertEqual(self.request().json['code'], 'throttled')
    self.now += 12
    with self.service.db() as c:
      c.execute('UPDATE sessions SET count=50 WHERE id=?', (self.session,))
    self.assertEqual(self.request().json['code'], 'session_limit')
    other = VisionService(self.service.path, config=self.service.config)
    self.assertEqual(other.status()['verified'], True)

  def test_invalid_image_and_origin(self):
    self.image = b'not-an-image'
    self.assertEqual(self.request().json['code'], 'invalid_image')
    self.assertEqual(self.client.post('/vision/sessions', json={'kind':'check'},
      headers={'Origin':'https://external.example'}).status_code, 403)
    self.generator.assert_not_called()

  def test_daily_and_check_caps(self):
    for _ in range(5):
      self.assertEqual(self.request().status_code, 200)
      self.now += 12
    self.assertEqual(self.request().json['code'], 'daily_limit')
    camera = self.service.session('camera')
    with self.service.db() as c:
      c.executemany('INSERT INTO attempts VALUES (?,?,?)',
        [(self.now, self.service.day(), 'camera')] * 495)
    self.session = camera
    self.assertEqual(self.request().json['code'], 'daily_limit')
    self.assertEqual(self.generator.call_count, 5)

  def test_empty_objects_and_changed_model(self):
    self.generator.return_value = '{"objects":[]}'
    self.assertEqual(self.request().json['objects'], [])
    self.session = self.service.session('camera')
    self.service.config = lambda: ('test-key', 'different-model')
    self.now += 12
    self.assertEqual(self.request().json['code'], 'check_required')
    self.assertFalse(self.service.status()['verified'])


  def test_boxes_and_exclusions(self):
    import json
    data = '{"objects":[{"label":"coin","box_2d":[0,0,1000,1000]},{"label":"hand","box_2d":[1,1,5,5]}]}'
    self.assertEqual(validate_result(data), [{'label':'coin','box_2d':[0,0,1000,1000]}])
    for box in ([0,0,0,1], [10,10,1,1], [-1,0,10,10], [0,0,1001,1000],
                [True,0,1,1], [0,0,1], [0,0,1.5,2]):
      with self.assertRaises(VisionError):
        validate_result(json.dumps({'objects':[{'label':'coin','box_2d':box}]}))

  def test_configurable_cadence_and_contract(self):
    from unittest.mock import patch
    with patch.dict('os.environ', {'GEMINI_INTERVAL_SECONDS':'30'}):
      self.assertEqual(self.service.status()['intervalSeconds'], 30)
      self.assertEqual(self.request().status_code, 200)
      self.now += 12
      self.assertEqual(self.request().json['code'], 'throttled')
      self.now += 18
      self.assertEqual(self.request().status_code, 200)
    for value in ('0', 'NaN', 'infinity', 'oops'):
      with patch.dict('os.environ', {'GEMINI_INTERVAL_SECONDS':value}):
        with self.assertRaises(VisionError):
          self.service.status()

  def test_flash_lite_fast_configuration(self):
    from unittest.mock import patch
    with patch('sdow.vision.genai.Client') as client:
      provider = client.return_value.__enter__.return_value
      provider.models.generate_content.return_value.text = '{"objects":[]}'
      self.assertEqual(generate(self.image, 'test-key', 'gemini-3.1-flash-lite'), '{"objects":[]}')
      args = provider.models.generate_content.call_args.kwargs
      self.assertEqual(args['model'], 'gemini-3.1-flash-lite')
      self.assertEqual(args['config'].thinking_config.thinking_level.value, 'MINIMAL')
      self.assertEqual(args['config'].media_resolution.value, 'MEDIA_RESOLUTION_MEDIUM')
      self.assertEqual(client.call_args.kwargs['http_options'].retry_options.attempts, 1)
      provider.models.generate_content.assert_called_once()

  def test_default_spacing_is_six_seconds(self):
    self.assertEqual(self.service.interval(), 6)
    self.assertEqual(self.request().status_code, 200)
    self.now += 5
    self.assertEqual(self.request().json['code'], 'throttled')
    self.now += 1
    self.assertEqual(self.request().status_code, 200)

  def test_inference_time_counts_toward_spacing(self):
    def timed_generation(*args):
      self.now += 3
      return '{"objects":[]}'
    self.service.generator = timed_generation
    result = self.request()
    self.assertEqual(result.status_code, 200)
    self.assertEqual(result.json['nextRequestAfterMs'], 3000)
    self.now += 3
    self.assertEqual(self.request().status_code, 200)


if __name__ == '__main__':
  unittest.main()
