export function pcm16(samples, sampleRate, targetRate = 16000) {
  const ratio = sampleRate / targetRate, result = new Int16Array(Math.floor(samples.length / ratio));
  for (let i=0;i<result.length;i++) { const start=Math.floor(i*ratio),end=Math.max(start+1,Math.floor((i+1)*ratio));let sum=0;for(let j=start;j<end&&j<samples.length;j++)sum+=samples[j];const value=Math.max(-1,Math.min(1,sum/(end-start)));result[i]=Math.round(value*(value<0?32768:32767)); }
  return result;
}
function base64(bytes){let str='';for(let i=0;i<bytes.length;i++)str+=String.fromCharCode(bytes[i]);return btoa(str);}
export function createLiveVoice({api,getConnection,onClosed,toast}) {
  const $=id=>document.getElementById(id),dialog=$('liveVoiceDialog');
  let run=0,active=false,stopping=false,muted=false,ready=false,stream,context,capture,source,inputMeter,outputMeter,silence,socket,session,heartbeat,clockTimer,connectTimer,closeTimer,animation,playTime=0,phase='connecting',sources=new Set(),captions='',userCaption='',level=0;
  const send=data=>{if(socket?.readyState===WebSocket.OPEN&&socket.bufferedAmount<128000)socket.send(JSON.stringify(data));};
  function status(text,state){$('liveVoiceStatus').textContent=text;if(state){phase=state;dialog.dataset.state=state;}}
  function stopPlayback(){for(const node of sources){try{node.stop();}catch{}}sources.clear();playTime=0;}
  function play(data){
    if(!context||context.state==='closed'||stopping)return;
    const binary=atob(data),samples=new Float32Array(Math.floor(binary.length/2));
    for(let i=0;i<samples.length;i++){let value=binary.charCodeAt(i*2)|(binary.charCodeAt(i*2+1)<<8);if(value&0x8000)value-=65536;samples[i]=value/32768;}
    if(playTime-context.currentTime>12){stopPlayback();status('Прервано воспроизведение. Говорите…','listening');return;}
    const buffer=context.createBuffer(1,samples.length,24000);buffer.copyToChannel(samples,0);
    const node=context.createBufferSource();node.buffer=buffer;node.connect(outputMeter);sources.add(node);node.onended=()=>{sources.delete(node);if(!sources.size&&ready&&!stopping)status(muted?'Микрофон выключен':'Слушаю…',muted?'muted':'listening');};
    playTime=Math.max(context.currentTime+0.025,playTime);node.start(playTime);playTime+=buffer.duration;status('Gemini отвечает…','speaking');
  }
  function animate(){
    if(!active)return;
    const rms=meter=>{if(!meter)return 0;const data=new Float32Array(meter.fftSize);meter.getFloatTimeDomainData(data);return Math.sqrt(data.reduce((a,b)=>a+b*b,0)/data.length);};
    const input=muted?0:rms(inputMeter),output=rms(outputMeter);level=level*.8+Math.min(1,Math.max(input,output)*5)*.2;$('liveVoiceOrb').style.setProperty('--voice-level',String(level));
    if(input>.15&&sources.size){stopPlayback();status('Слушаю…','listening');}
    animation=requestAnimationFrame(animate);
  }
  function transmit(buffer){
    if(!active||!ready||muted||stopping||!context||socket?.readyState!==WebSocket.OPEN)return;
    if(socket.bufferedAmount>128000){status('Медленное соединение…','connecting');return;}
    const samples=pcm16(new Float32Array(buffer),context.sampleRate);if(!samples.length)return;
    send({type:'audio',data:base64(new Uint8Array(samples.buffer))});
  }
  async function releaseAudio(){
    cancelAnimationFrame(animation);stopPlayback();stream?.getTracks().forEach(track=>track.stop());
    try{capture?.disconnect();source?.disconnect();silence?.disconnect();}catch{}
    if(context&&context.state!=='closed')await context.close().catch(()=>{});
    stream=context=capture=source=inputMeter=outputMeter=silence=null;
  }
  let completing;
  async function complete(reason){
    if(completing)return completing;
    active=false;ready=false;clearInterval(heartbeat);clearInterval(clockTimer);clearTimeout(connectTimer);clearTimeout(closeTimer);
    completing=(async()=>{await releaseAudio();try{socket?.close();}catch{};socket=null;if(session){try{await api('/api/live/cancel',{method:'POST',body:JSON.stringify({sessionId:session.sessionId})});}catch{}}session=null;if(dialog.open)dialog.close();if(reason&&reason!=='Разговор завершён')toast(reason);await onClosed();stopping=false;})().finally(()=>{completing=null;});
    return completing;
  }
  async function stop(){
    if(!active||stopping)return;
    stopping=true;ready=false;++run;clearTimeout(connectTimer);void releaseAudio();if(dialog.open)dialog.close();
    if(socket?.readyState===WebSocket.OPEN){send({type:'stop'});closeTimer=setTimeout(()=>void complete(),4000);}else await complete();
  }
  async function start(chatId){
    if(active||completing)return;
    active=true;stopping=false;muted=false;ready=false;session=null;captions=userCaption='';$('liveVoiceCaption').textContent='';$('liveVoiceTime').textContent='';$('liveVoiceMic').setAttribute('aria-pressed','false');$('liveVoiceMic').setAttribute('aria-label','Выключить микрофон');dialog.classList.remove('voice-muted');$('liveVoiceMic').disabled=true;
    const current=++run;dialog.showModal();status('Подключаем голос…','connecting');
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('Браузер не поддерживает микрофон. Откройте сайт в Safari или Chrome.');
      const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw new Error('В этом браузере нет поддержки голосового режима.');
      context=new Audio();await context.resume();
      const acquired=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(current!==run){acquired.getTracks().forEach(t=>t.stop());return;}stream=acquired;
      inputMeter=context.createAnalyser();inputMeter.fftSize=512;outputMeter=context.createAnalyser();outputMeter.fftSize=512;outputMeter.connect(context.destination);
      source=context.createMediaStreamSource(stream);source.connect(inputMeter);silence=context.createGain();silence.gain.value=0;silence.connect(context.destination);
      if(context.audioWorklet){await context.audioWorklet.addModule(new URL('./voice-capture.js',import.meta.url));if(current!==run)return;capture=new AudioWorkletNode(context,'ai-studio-voice-capture');capture.port.onmessage=event=>transmit(event.data);}
      else{capture=context.createScriptProcessor(2048,1,1);capture.onaudioprocess=event=>transmit(event.inputBuffer.getChannelData(0).slice().buffer);}
      inputMeter.connect(capture);capture.connect(silence);
      const issued=await api('/api/live/session',{method:'POST',body:JSON.stringify({chatId})});
      if(current!==run){await api('/api/live/cancel',{method:'POST',body:JSON.stringify({sessionId:issued.sessionId})});return;}
      session=issued;const tick=()=>{const left=Math.max(0,Math.ceil((issued.expiresAt-Date.now())/1000));$('liveVoiceTime').textContent=`${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;};tick();clockTimer=setInterval(tick,1000);const url=new URL(getConnection().apiUrl+'/api/live/socket');url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('ticket',issued.ticket);
      socket=new WebSocket(url);connectTimer=setTimeout(()=>void complete('Не удалось подключить голос. Попробуйте ещё раз.'),75000);
      socket.onmessage=async event=>{
        if(current!==run&&!stopping)return;
        try{
          const data=JSON.parse(typeof event.data==='string'?event.data:await event.data.text());
          if(data.type==='ready'){clearTimeout(connectTimer);ready=true;$('liveVoiceMic').disabled=false;status('Слушаю…','listening');heartbeat=setInterval(()=>send({type:'ping'}),10000);animation=requestAnimationFrame(animate);}
          if(data.type==='content'){
            const content=data.content;
            if(content.interrupted){stopPlayback();status(muted?'Микрофон выключен':'Слушаю…',muted?'muted':'listening');}
            if(content.inputTranscription?.text){userCaption+=content.inputTranscription.text;$('liveVoiceCaption').textContent=userCaption.slice(-500);}
            if(content.outputTranscription?.text){captions+=content.outputTranscription.text;$('liveVoiceCaption').textContent=captions.slice(-500);}
            for(const part of content.modelTurn?.parts||[])if(part.inlineData?.data)play(part.inlineData.data);
            if(content.turnComplete){captions=userCaption='';if(!sources.size)status(muted?'Микрофон выключен':'Слушаю…',muted?'muted':'listening');}
          }
          if(data.type==='ended')await complete(data.reason);
        }catch{await complete('Ошибка голосового соединения. Попробуйте ещё раз.');}
      };
      socket.onclose=()=>{if(active)void complete(stopping?null:'Голосовое соединение завершено.');};
      socket.onerror=()=>{if(active)void complete('Не удалось соединиться с Gemini Live. Попробуйте ещё раз.');};
      stream.getAudioTracks()[0]?.addEventListener('ended',()=>{if(active)void stop();});
    }catch(error){if(current===run)await complete(error.name==='NotAllowedError'?'Разрешите доступ к микрофону в браузере.':error.message||'Не удалось включить голос.');}
  }
  $('liveVoiceClose').addEventListener('click',()=>void stop());
  $('liveVoiceMic').addEventListener('click',()=>{if(!ready||stopping)return;muted=!muted;stream?.getAudioTracks().forEach(track=>track.enabled=!muted);$('liveVoiceMic').setAttribute('aria-pressed',String(muted));$('liveVoiceMic').setAttribute('aria-label',muted?'Включить микрофон':'Выключить микрофон');dialog.classList.toggle('voice-muted',muted);if(muted)send({type:'mute'});status(muted?'Микрофон выключен':'Слушаю…',muted?'muted':'listening');});
  dialog.addEventListener('cancel',event=>{event.preventDefault();void stop();});
  dialog.addEventListener('close',()=>{if(active&&!stopping)void stop();});
  window.addEventListener('pagehide',()=>{stream?.getTracks().forEach(t=>t.stop());send({type:'stop'});try{socket?.close();}catch{}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&active)void stop();});
  return {start,stop,get active(){return active;}};
}
