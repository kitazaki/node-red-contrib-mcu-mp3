import {Node} from "nodered";
import ResourceStreamer from "mp3resourcestreamer";

class Mp3 extends Node {
	#streamer;

	onStart(config) {
		super.onStart(config);

		this.volume = normalizeVolume(config.volume);

		trace(`mcu_mp3 start: volume=${this.volume}\n`);
	}

	onMessage(msg, done) {
		if (this.#streamer) {
			this.#streamer.close();
			this.#streamer = undefined;
		}

		const streamer = new ResourceStreamer({
			data: msg.payload,

			// sampleRate は固定しない。
			// mp3resourcestreamer.js 側でMP3から自動検出する。
			bitsPerSample: 16,
			numChannels: 1,

			volume: this.volume,

			bufferFrames: 24,
			maxFrames: 64,

			onError: e => {
				trace("ERROR: ", e, "\n");

				if (this.#streamer === streamer) {
					streamer.close();
					this.#streamer = undefined;
				}

				done();
			},

			onDone: () => {
				trace("Done\n");

				if (this.#streamer === streamer) {
					streamer.close();
					this.#streamer = undefined;
				}

				done();
			}
		});

		this.#streamer = streamer;
	}

	static type = "mcu_mp3";

	static {
		RED.nodes.registerType(this.type, this);
	}
}

function normalizeVolume(value) {
	value = Number(value);

	if (isNaN(value))
		return 0.15;

	if (value > 1)
		value = value / 256;

	if (value < 0)
		value = 0;
	else if (value > 1)
		value = 1;

	return value;
}

export default Mp3;
