class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor(){super();this.samples=new Float32Array(2048);this.offset=0;}
  process(inputs){const input=inputs[0]?.[0];if(!input)return true;for(let i=0;i<input.length;i++){this.samples[this.offset++]=input[i];if(this.offset===this.samples.length){this.port.postMessage(this.samples.buffer,[this.samples.buffer]);this.samples=new Float32Array(2048);this.offset=0;}}return true;}
}
registerProcessor('ai-studio-voice-capture',VoiceCaptureProcessor);
