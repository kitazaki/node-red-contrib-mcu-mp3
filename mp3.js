import {Node} from "nodered";
import AudioOut from "pins/audioout";
import ResourceStreamer from "mp3resourcestreamer";
let audio, volume;

class Mp3 extends Node {
    onStart(config) {
        super.onStart(config);
        volume = Number(config.volume);
	//console.log("key,volume:"+key+","+volume);

	audio = new AudioOut({});
        audio.enqueue(0, AudioOut.Volume, volume);
        audio.start();
    };
    onMessage(msg, done) {
	//console.log("msg:"+msg.payload);

	new ResourceStreamer({
		data: msg.payload,
		audio: {
			out: audio,
			sampleRate: 44100,
			stream: 0
		},
		onError(e) {
			trace("ERROR: ", e, "\n");
			//this.close();
                        done();
		},
		onDone() {
			trace("Done\n");
			//this.close();
			done();
		}
	})

	//this.send(msg);
        //done();
    };
    static type = "mcu_mp3";
    static {
         RED.nodes.registerType(this.type, this)
    };
};

