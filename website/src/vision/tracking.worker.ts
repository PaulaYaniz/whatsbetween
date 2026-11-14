import {MotionTracker} from './tracking';
import type {TrackerMessage} from './tracking';

const tracker = new MotionTracker();
self.onmessage = (event: MessageEvent<TrackerMessage>) => {
  const message = event.data;
  const objects =
    message.type === 'seed'
      ? tracker.seed(message.objects, message.frame)
      : tracker.push(message.frame);
  self.postMessage({objects, time: message.frame.time});
};
