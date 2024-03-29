import axios from "axios"

// initializing axios
const api = axios.create({
  baseURL: "/",
})

export class Uploader {
  constructor(options) {
    this.useTransferAcceleration = options.useTransferAcceleration
    // this must be bigger than or equal to 5MB,
    // otherwise AWS will respond with:
    // "Your proposed upload is smaller than the minimum allowed size"
    options.chunkSize = options.chunkSize || 0
    this.chunkSize = Math.max((1024 * 1024 * options.chunkSize), (1024 * 1024 * 5))
    console.log("ChunkSize - B:", this.chunkSize , ",MB:" , Math.round(this.chunkSize/(1024*1024)));
    // number of parallel uploads
    options.threadsQuantity = options.threadsQuantity || 0
    this.threadsQuantity = Math.min(options.threadsQuantity || 5, 15)
    console.log("noOfThreads :" + this.threadsQuantity);

    // adjust the timeout value to activate exponential backoff retry strategy 
    this.timeout = 0
    this.file = options.file
    this.fileName = options.fileName
    this.aborted = false
    this.uploadedSize = 0
    this.progressCache = {}
    this.activeConnections = {}
    this.parts = []
    this.uploadedParts = []
    this.fileId = null
    this.fileKey = null
    this.onProgressFn = () => {}
    this.onErrorFn = () => {}
    this.baseURL = options.baseURL
  }

  start() {
    this.initialize()
  }

  async initialize() {
    console.log("-- initialize -- started");
    try {
      // adding the the file extension (if present) to fileName
      let fileName = this.file.name

      // initializing the multipart request
      const videoInitializationUploadInput = {
        name: fileName,
      }
      console.log("initialize => /uploads/initializeMultipartUpload api called");
      const initializeReponse = await api.request({
        url: "/uploads/initializeMultipartUpload",
        method: "POST",
        data: videoInitializationUploadInput,
        baseURL:this.baseURL
      })

      console.log("initialize => /uploads/initializeMultipartUpload api completed");
      const AWSFileDataOutput = initializeReponse.data

      this.fileId = AWSFileDataOutput.fileId
      this.fileKey = AWSFileDataOutput.fileKey

      // retrieving the pre-signed URLs
      const numberOfparts = Math.ceil(this.file.size / this.chunkSize)
      console.log("noOfParts:" , numberOfparts);
      const AWSMultipartFileDataInput = {
        fileId: this.fileId,
        fileKey: this.fileKey,
        parts: numberOfparts,
      }

      console.log("initialize => /uploads/getMultipartPreSignedUrls api started");
      const urlsResponse = await api.request( {
        url: this.useTransferAcceleration?"/uploads/getMultipartPreSignedUrls":"/uploads/getMultipartPreSignedUrls",
        method: "POST",
        data: AWSMultipartFileDataInput,
        baseURL:this.baseURL
      })
      console.log("initialize => /uploads/getMultipartPreSignedUrls api completed");
      const newParts = urlsResponse.data.parts
      console.log("parts", newParts);
      this.parts.push(...newParts)

      this.sendNext()
    } catch (error) {
      await this.complete(error)
    }
  }

  sendNext(retry=0) {
    const activeConnections = Object.keys(this.activeConnections).length
    let maxConnectionsReached = activeConnections >= this.threadsQuantity;
    console.log("Active Connections:", activeConnections, ",threadsQuantity:" , this.threadsQuantity, "partsLength:" , this.parts.length,"retry:", retry
    ,"maxConnectionsReached:", maxConnectionsReached, "online:", navigator.onLine);

    if (maxConnectionsReached || !navigator.onLine) {
      // Check if the maximum parallel connections are reached or if the system is offline
      console.log( "Retry after 10 seconds")
      setTimeout(() => this.sendNext(retry), 10000); // Retry after 10 seconds
      return
    }

    if (!this.parts.length) {
      if (!activeConnections) {
        this.complete()
      }

      return
    }

    const part = this.parts.pop()    
    if (this.file && part) {
      const sentSize = (part.PartNumber - 1) * this.chunkSize;
      const chunk = this.file.slice(sentSize, sentSize + this.chunkSize)
      // console.log("sentSize:", sentSize, ",chunkSize", this.chunkSize);
      console.log("sentSize(MB):", Math.round(sentSize/(1024*1024)), ",chunkSize(MB)", Math.round(this.chunkSize/(1024*1024)));

      const sendChunkStarted = () => {
        this.sendNext()
      }

      this.sendChunk(chunk, part, sendChunkStarted)
        .then(() => {
          this.sendNext()
        })
        .catch((error) => {          
          if (retry <= 6){
            retry++
            const wait = (ms) => new Promise((res) => setTimeout(res, ms));
            //exponential backoff retry before giving up
            console.log(`Part#${part.PartNumber} failed to upload, backing off ${2 ** retry * 100} before retrying...`)
            wait(2 ** retry * 1000).then(() => {              
              this.parts.push(part)
              this.sendNext(retry)
            })
          }else{
            console.log(`Part#${part.PartNumber} failed to upload, giving up`)
            this.complete(error)
          }
        })
    }
  }

  async complete(error) {
    if (error && !this.aborted) {
      this.onErrorFn(error)
      return
    }

    if (error) {
      this.onErrorFn(error)
      return
    }

    try {
      await this.sendCompleteRequest()
    } catch (error) {
      this.onErrorFn(error)
    }
  }

  async sendCompleteRequest() {
    if (this.fileId && this.fileKey) {
      const videoFinalizationMultiPartInput = {
        fileId: this.fileId,
        fileKey: this.fileKey,
        parts: this.uploadedParts,
      }

      await api.request({
        url: "/uploads/finalizeMultipartUpload",
        method: "POST",
        data: videoFinalizationMultiPartInput,
        baseURL:this.baseURL
      })
    }
  }

  sendChunk(chunk, part, sendChunkStarted) {
    return new Promise((resolve, reject) => {
      this.upload(chunk, part, sendChunkStarted)
        .then((status) => {
          if (status !== 200) {
            reject(new Error("Failed chunk upload"))
            return
          }

          resolve()
        })
        .catch((error) => {
          reject(error)
        })
    })
  }

  handleProgress(part, event) {
    if (this.file) {
      if (event.type === "progress" || event.type === "error" || event.type === "abort") {
        this.progressCache[part] = event.loaded
      }

      if (event.type === "uploaded") {
        this.uploadedSize += this.progressCache[part] || 0
        delete this.progressCache[part]
      }

      const inProgress = Object.keys(this.progressCache)
        .map(Number)
        .reduce((memo, id) => (memo += this.progressCache[id]), 0)

      const sent = Math.min(this.uploadedSize + inProgress, this.file.size)

      const total = this.file.size

      const percentage = Math.round((sent / total) * 100)

      this.onProgressFn({
        sent: sent,
        total: total,
        percentage: percentage,
      })
    }
  }

  upload(file, part, sendChunkStarted) {
    // uploading each part with its pre-signed URL
    return new Promise((resolve, reject) => {
      const throwXHRError = (error, part, abortFx) => {    
        delete this.activeConnections[part.PartNumber - 1]
        reject(error)
        window.removeEventListener('offline', abortFx)    
      }      
      if (this.fileId && this.fileKey) {
        if(!window.navigator.onLine)
          reject(new Error("System is offline"))

        const xhr = (this.activeConnections[part.PartNumber - 1] = new XMLHttpRequest())
        xhr.timeout = this.timeout
        sendChunkStarted()

        const progressListener = this.handleProgress.bind(this, part.PartNumber - 1)

        xhr.upload.addEventListener("progress", progressListener)

        xhr.addEventListener("error", progressListener)
        xhr.addEventListener("abort", progressListener)
        xhr.addEventListener("loadend", progressListener)

        xhr.open("PUT", part.signedUrl)
        const abortXHR = () => xhr.abort()
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4 && xhr.status === 200) {
            const ETag = xhr.getResponseHeader("ETag")

            if (ETag) {
              const uploadedPart = {
                PartNumber: part.PartNumber,
                ETag: ETag.replaceAll('"', ""),
              }

              this.uploadedParts.push(uploadedPart)

              resolve(xhr.status)
              delete this.activeConnections[part.PartNumber - 1]
              window.removeEventListener('offline', abortXHR)
            }
          }
        }

        xhr.onerror = (error) => {
          throwXHRError(error, part, abortXHR)
        }
        xhr.ontimeout = (error) => {
          throwXHRError(error, part, abortXHR)
        }
        xhr.onabort = () => {
          throwXHRError(new Error("Upload canceled by user or system"), part)
        }
        window.addEventListener('offline', abortXHR);
        xhr.send(file)
      }
    })
  }



  onProgress(onProgress) {
    this.onProgressFn = onProgress
    return this
  }

  onError(onError) {
    this.onErrorFn = onError
    return this
  }

  abort() {
    Object.keys(this.activeConnections)
      .map(Number)
      .forEach((id) => {
        this.activeConnections[id].abort()
      })

    this.aborted = true
  }
}
