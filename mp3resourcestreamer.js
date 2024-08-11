import MP3 from "mp3/decode";

class ResourceStreamer {
        #audio;
        #stream;
        #playing = [];
        #bytesQueued = 0;
        #targetBytesQueued;
        #bytesPerSample = 2;
        #bytesPerBlock;
        #callbacks = [];
        #resource;
        #mp3 = new MP3;
        #info = {};

  constructor(options) {
    this.#resource = new Uint8Array(options.data);
    //trace("DEBUG 1\n");
    this.#resource.position = 0;
    const sampleRate = options.audio.sampleRate;
    this.#targetBytesQueued = (sampleRate * 2) / 4;             // quarter second
    this.#targetBytesQueued = Math.idiv(this.#targetBytesQueued, 1152) * 1152;
    this.#bytesPerBlock = 1152;

    if (options.onError) this.#callbacks.onError = options.onError;
    if (options.onDone) this.#callbacks.onDone = options.onDone;

    const audio = options.audio.out;
    this.#audio = audio;
    this.#stream = options.audio.stream ?? 0;
    audio.callbacks ??= [];
    audio.callbacks[this.#stream] = (bytes) => {
      if (!bytes) {
        this.#callbacks.onDone?.();
        return;
      }

      this.#bytesQueued -= bytes;
      let played = this.#playing.shift();
      played = undefined;
      this.#fillQueue();
    };
    this.#fillQueue();
    this.#audio.start();
  }
        close() {
                if (this.#audio) {
                        this.#audio.enqueue(this.#stream, this.#audio.constructor.Flush);
                        this.#audio.callbacks[this.#stream] = null;
                }
                this.#mp3?.close();

                this.#audio = this.#playing = this.#mp3 = undefined;
        }
        #fillQueue() {
                while (
                        this.#bytesQueued < this.#targetBytesQueued &&
                        this.#resource.position < this.#resource.byteLength &&
                        this.#audio.length(this.#stream) >= 2
                        ) {
                        const found = MP3.scan(this.#resource, this.#resource.position, this.#resource.byteLength, this.#info);
			//trace("DEBUG 2\n");
                        if (!found) {
                                this.#resource.position = this.#resource.byteLength;
                                this.#audio.enqueue(0, this.#audio.constructor.Callback, 0);
                                break;
                        } 
                        
                        //const slice = new SharedArrayBuffer(1152 * 2);
                        const slice = new SharedArrayBuffer(1152 * 3);
                        let result = this.#mp3.decode(this.#resource.subarray(found.position, found.position + found.length + MP3.BUFFER_GUARD), slice);
                        if (!result) {
                                this.#resource.position += 1;
                                continue;
                        }

                        this.#resource.position = found.position + result;

                        this.#audio.enqueue(
                                this.#stream,
                                this.#audio.constructor.RawSamples,
                                slice,
                                1,
                                0,
                                slice.samples
                        );
                        this.#audio.enqueue(
                                this.#stream,
                                this.#audio.constructor.Callback,
                                slice.byteLength
                        );
                        this.#bytesQueued += slice.byteLength;
                        this.#playing.push(slice);

                        if (found.position >= this.#resource.byteLength)
                                this.#audio.enqueue(0, this.#audio.constructor.Callback, 0);
            }
        }
}

export default ResourceStreamer;
