// Deterministic motion tests; no camera, network, or Gemini quota.
import assert from 'node:assert/strict';
import {MotionTracker} from '../website/src/vision/tracking.ts';
const width=320,height=180;
function frame(dx=0,dy=0,time=1000,visible=true,scale=1) {
  const pixels=new Uint8Array(width*height).fill(20);
  for(let y=0;y<60*scale;y++) for(let x=0;x<80*scale;x++) {
    const tx=50+dx+x,ty=40+dy+y;
    if(visible && tx>=0&&tx<width&&ty>=0&&ty<height) {
      const sx=Math.floor(x/scale),sy=Math.floor(y/scale);
      pixels[ty*width+tx]=50+((sx*137+sy*73+sx*sy*19)%180);
    }
  }
  return {width,height,time,pixels};
}
const objects=[{label:'book',box_2d:[40/height*1000,50/width*1000,100/height*1000,130/width*1000]}];
const tracker=new MotionTracker();
tracker.push(frame());
assert(tracker.seed(objects,frame())[0].tracking);
const started=performance.now();
for(let i=1;i<=20;i++) {
  const result=tracker.push(frame(i*2,i,1000+i*100));
  assert(result[0].tracking,`lost at ${i}`);
  assert(Math.abs(result[0].box_2d[1]/1000*width-(50+i*2))<2, 'horizontal motion');
  assert(Math.abs(result[0].box_2d[0]/1000*height-(40+i))<2, 'vertical motion');
}
const average=(performance.now()-started)/20;
assert.equal(tracker.push(frame(40,20,3100,false))[0].tracking,false,'disappearance clears overlay');
assert.equal(tracker.push(frame(40,20,3200))[0].tracking,false,'no invented reacquisition');
const delayed=new MotionTracker();
for(let i=0;i<=10;i++) delayed.push(frame(i*2,i,1000+i*100));
const caughtUp=delayed.seed(objects,frame())[0];
assert(caughtUp.tracking,'replay tracks delayed detection');
assert(Math.abs(caughtUp.box_2d[1]/1000*width-70)<2,'response catches up to current frame');
assert.equal(delayed.push(frame(22,11,12000)).length,0,'stale labels expire');
const plain=new MotionTracker();
assert.equal(plain.seed(objects,frame(0,0,1000,false))[0].tracking,false,'plain regions never fake tracking');
const gap=new MotionTracker();gap.push(frame());gap.seed(objects,frame());
assert.equal(gap.push(frame(1,1,2000))[0].tracking,false,'frame gap loses tracking');
const resize=new MotionTracker();resize.push(frame());resize.seed(objects,frame());
assert.equal(resize.push({...frame(0,0,1100),width:160,height:360})[0].tracking,false,'resolution changes invalidate tracking');
const duplicate=new MotionTracker();
const separate=duplicate.seed([...objects,...objects],frame());
assert.notEqual(separate[0].id,separate[1].id,'same-label detections are distinct');
console.log(`PASS: moving boxes, delayed-response catch-up, disappearance, no false reacquisition, expiry, low texture, frame gaps, resolution changes, duplicate objects. ${average.toFixed(1)}ms per tracked-object update.`);
