import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveMeter } from './live-voice.js';
import { pcm16 } from '../live-voice.js';
test('Live usage accumulates per turn without double counting repeated metadata',()=>{
 const meter=new LiveMeter(100);meter.acceptAudio(32000);assert.deepEqual(meter.balance(),{used:300,estimated:true});
 meter.acceptServer({usageMetadata:{totalTokenCount:150}});meter.acceptServer({usageMetadata:{totalTokenCount:170}});assert.deepEqual(meter.balance(),{used:170,estimated:false});
 meter.acceptServer({serverContent:{turnComplete:true}});assert.equal(meter.balance().used,170);
 meter.acceptAudio(16000);meter.acceptServer({usageMetadata:{totalTokenCount:230},serverContent:{turnComplete:true}});assert.deepEqual(meter.balance(),{used:400,estimated:false});
 meter.acceptText('hello');assert.equal(meter.balance().estimated,true);assert.equal(meter.balance().used,505);
 meter.acceptServer({usageMetadata:{totalTokenCount:-2}});assert.equal(meter.balance().used,505);
});
test('Browser PCM capture downsamples and clips without touching the original microphone buffer',()=>{
 const samples=new Float32Array([1,1,1,-1,-1,-1,2,2,2,-2,-2,-2]);const copy=samples.slice();
 assert.deepEqual([...pcm16(samples,48000)],[32767,-32768,32767,-32768]);assert.deepEqual(samples,copy);
 assert.deepEqual([...pcm16(new Float32Array([0,.5,-.5]),16000)],[0,16384,-16384]);
});
