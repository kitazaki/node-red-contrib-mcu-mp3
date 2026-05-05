import AudioOut from "embedded:io/audio/out";
import MP3 from "mp3/decode";
import Timer from "timer";

class ResourceStreamer {
	#resource;
	#mp3 = new MP3;
	#info = {};

	#output;

	#queue = [];
	#current;
	#position = 0;

	#free = [];

	#queuedSamples = 0;
	#targetSamplesQueued;
	#maxSamplesQueued;

	#sampleRate;
	#bitsPerSample;
	#numChannels;
	#volume;

	#callbacks = {};
	#done = false;
	#doneCalled = false;
	#started = false;
	#closed = false;

	#closeTimer;
	#drainDelay = 300;

	constructor(options) {
		this.#resource = toUint8Array(options.data);
		this.#resource.position = 0;

		this.#bitsPerSample = options.bitsPerSample ?? 16;
		this.#numChannels = options.numChannels ?? 1;
		this.#volume = options.volume ?? 0.15;

		const bufferFrames = options.bufferFrames ?? 24;
		const maxFrames = options.maxFrames ?? 64;

		this.#targetSamplesQueued = 1152 * bufferFrames;
		this.#maxSamplesQueued = 1152 * maxFrames;

		if (options.onError)
			this.#callbacks.onError = options.onError;

		if (options.onDone)
			this.#callbacks.onDone = options.onDone;

		// MP3の最初のフレームヘッダからサンプルレートを自動検出する。
		this.#sampleRate = options.sampleRate ?? this.#detectSampleRate() ?? 44100;

		this.#output = new AudioOut({
			sampleRate: this.#sampleRate,
			bitsPerSample: this.#bitsPerSample,
			numChannels: this.#numChannels,

			onWritable: size => {
				this.#onWritable(size);
			}
		});

		trace(`ResourceStreamer embedded audio: bytes=${this.#resource.byteLength}, rate=${this.#sampleRate}, channels=${this.#numChannels}, volume=${this.#volume}\n`);

		this.#fillQueue();
		this.start();
	}

	#detectSampleRate() {
		const found = MP3.scan(this.#resource, 0, this.#resource.byteLength, this.#info);

		if (!found) {
			trace("MP3 detect: frame not found\n");
			return undefined;
		}

		const format = parseMP3Header(this.#resource, found.position);

		if (format) {
			trace(`MP3 detected: sampleRate=${format.sampleRate}, channels=${format.channels}, version=${format.version}, layer=${format.layer}\n`);
			this.#numChannels = format.channels;
			return format.sampleRate;
		}

		trace("MP3 detected, but header parse failed\n");
		return undefined;
	}

	start() {
		if (this.#closed)
			return;

		if (!this.#started) {
			this.#started = true;
			this.#output.start();
		}
	}

	stop() {
		if (!this.#started)
			return;

		try {
			if (this.#output?.stop)
				this.#output.stop();
		}
		catch {
		}

		this.#started = false;
	}

	close() {
		if (this.#closed)
			return;

		this.#closed = true;

		if (this.#closeTimer) {
			Timer.clear(this.#closeTimer);
			this.#closeTimer = undefined;
		}

		try {
			this.stop();
		}
		catch {
		}

		try {
			if (this.#output?.close)
				this.#output.close();
		}
		catch {
		}

		try {
			this.#mp3?.close();
		}
		catch {
		}

		this.#resource = undefined;
		this.#mp3 = undefined;
		this.#output = undefined;

		this.#queue.length = 0;
		this.#free.length = 0;
		this.#current = undefined;
	}

	#fillQueue() {
		if (this.#closed)
			return;

		while (
			(this.#queuedSamples < this.#targetSamplesQueued) &&
			(this.#queuedSamples < this.#maxSamplesQueued) &&
			(this.#resource.position < this.#resource.byteLength)
		) {
			const found = MP3.scan(
				this.#resource,
				this.#resource.position,
				this.#resource.byteLength,
				this.#info
			);

			if (!found) {
				this.#resource.position = this.#resource.byteLength;
				this.#done = true;
				break;
			}

			// 安定版:
			// ファイル末尾に BUFFER_GUARD 分の余白がないフレームは無理に補完しない。
			// 0埋め補完は短いMP3で RangeError や無音化の原因になったため戻す。
			if ((found.position + found.length + MP3.BUFFER_GUARD) > this.#resource.byteLength) {
				this.#resource.position = this.#resource.byteLength;
				this.#done = true;
				break;
			}

			const raw = this.#free.shift() ?? new SharedArrayBuffer(1152 * 2);

			const consumed = this.#mp3.decode(
				this.#resource.subarray(
					found.position,
					found.position + found.length + MP3.BUFFER_GUARD
				),
				raw
			);

			if (!consumed) {
				this.#resource.position = found.position + 1;
				continue;
			}

			this.#resource.position = found.position + consumed;

			const samples = raw.samples ?? 1152;
			const pcmBytes = samples * 2;

			const buffer = new Uint8Array(raw, 0, pcmBytes);

			this.#applyVolumeInPlace(buffer);

			this.#queue.push({
				buffer,
				raw,
				samples,
				position: 0
			});

			this.#queuedSamples += samples;
		}

		if (this.#resource.position >= this.#resource.byteLength)
			this.#done = true;
	}

	#applyVolumeInPlace(buffer) {
		if (1 === this.#volume)
			return;

		const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

		for (let i = 0; i < buffer.byteLength; i += 2) {
			let sample = view.getInt16(i, true);

			sample = Math.trunc(sample * this.#volume);

			if (sample > 32767)
				sample = 32767;
			else if (sample < -32768)
				sample = -32768;

			view.setInt16(i, sample, true);
		}
	}

	#onWritable(size) {
		if (this.#closed)
			return;

		while (size > 0) {
			if (!this.#current) {
				this.#current = this.#queue.shift();
				this.#position = 0;

				if (!this.#current) {
					this.#fillQueue();

					if (!this.#queue.length) {
						this.#checkDone();
						return;
					}

					continue;
				}
			}

			const buffer = this.#current.buffer;
			let use = buffer.byteLength - this.#position;

			if (use > size)
				use = size;

			// 16bit PCMなので2バイト境界に揃える
			use &= ~1;

			if (use <= 0)
				return;

			this.#output.write(buffer.subarray(this.#position, this.#position + use));

			this.#position += use;
			size -= use;

			if (this.#position >= buffer.byteLength) {
				this.#queuedSamples -= this.#current.samples;

				this.#free.push(this.#current.raw);

				this.#current = undefined;
				this.#position = 0;

				this.#fillQueue();
			}
		}
	}

	#checkDone() {
		if (!this.#done)
			return;

		if (this.#doneCalled)
			return;

		if (this.#queue.length)
			return;

		if (this.#current)
			return;

		this.#doneCalled = true;

		const onDone = this.#callbacks.onDone;

		// 最後の write() の直後に close() すると、AudioOut 内部バッファが
		// 鳴り切る前に止まることがあるため、close 前に少し待つ。
		this.#closeTimer = Timer.set(() => {
			this.#closeTimer = undefined;

			this.close();

			onDone?.();
		}, this.#drainDelay);
	}
}

function parseMP3Header(bytes, offset) {
	if ((offset + 4) > bytes.byteLength)
		return undefined;

	const b0 = bytes[offset];
	const b1 = bytes[offset + 1];
	const b2 = bytes[offset + 2];
	const b3 = bytes[offset + 3];

	// sync: 11 bits
	if ((0xFF !== b0) || (0xE0 !== (b1 & 0xE0)))
		return undefined;

	const versionBits = (b1 >> 3) & 0x03;
	const layerBits = (b1 >> 1) & 0x03;
	const sampleRateIndex = (b2 >> 2) & 0x03;
	const channelMode = (b3 >> 6) & 0x03;

	// reserved
	if (0x01 === versionBits)
		return undefined;

	// reserved
	if (0x00 === layerBits)
		return undefined;

	// reserved
	if (0x03 === sampleRateIndex)
		return undefined;

	let sampleRates;
	let version;

	switch (versionBits) {
		case 0x03:
			version = "MPEG1";
			sampleRates = [44100, 48000, 32000];
			break;

		case 0x02:
			version = "MPEG2";
			sampleRates = [22050, 24000, 16000];
			break;

		case 0x00:
			version = "MPEG2.5";
			sampleRates = [11025, 12000, 8000];
			break;
	}

	let layer;

	switch (layerBits) {
		case 0x03:
			layer = "Layer I";
			break;

		case 0x02:
			layer = "Layer II";
			break;

		case 0x01:
			layer = "Layer III";
			break;
	}

	return {
		sampleRate: sampleRates[sampleRateIndex],
		channels: (0x03 === channelMode) ? 1 : 2,
		version,
		layer
	};
}

function toUint8Array(data) {
	if (data instanceof Uint8Array)
		return data;

	if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer)
		return new Uint8Array(data);

	if (data?.buffer)
		return new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength);

	throw new Error("unsupported mp3 payload");
}

export default ResourceStreamer;
