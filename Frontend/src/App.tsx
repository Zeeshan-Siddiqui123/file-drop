import { useEffect, useRef, useState, type ReactNode } from 'react'
import { io, type Socket } from 'socket.io-client'
import QRCode from 'qrcode'
import './App.css'

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CHUNK_SIZE = 16 * 1024
const CHUNKS_PER_BATCH = 16
const MEMORY_LIMIT = 128 * 1024 * 1024
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024

type Peer = { peerId: string; name: string }
type JoinResult = { ok: boolean; peerId?: string; peers?: Peer[]; error?: string }
type TransferStatus = 'waiting' | 'transferring' | 'complete' | 'error'
type Transfer = {
  direction: 'send' | 'receive'
  fileName: string
  size: number
  progress: number
  status: TransferStatus
  message?: string
}
type Message =
  | { type: 'file-offer'; transferId: string; name: string; size: number; mimeType: string }
  | { type: 'accept'; transferId: string }
  | { type: 'reject'; transferId: string; reason?: string }
  | { type: 'batch-end'; transferId: string; batch: number; bytes: number }
  | { type: 'batch-ack'; transferId: string; batch: number }
  | { type: 'complete'; transferId: string }
  | { type: 'complete-ack'; transferId: string }
  | { type: 'cancel'; transferId: string; reason?: string }

type WritableFile = {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}
type SaveFilePicker = (options?: { suggestedName?: string }) => Promise<{ createWritable(): Promise<WritableFile> }>

const savePicker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker

function getLargeFileSaveHint() {
  if (savePicker) return ''
  if (!window.isSecureContext) {
    return 'This phone opened the local HTTP address. Browser security blocks direct-to-disk saving over HTTP, so files over 128 MiB cannot be received here. Open the app from its HTTPS deployment instead.'
  }
  return 'This browser does not support direct-to-disk saving. Use a supported browser on HTTPS; otherwise this device is limited to 128 MiB per transfer.'
}

function makeRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (byte) => ROOM_ALPHABET[byte & 31]).join('')
}

function makeTransferId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    bolt: <path d="m13 2-3 8h7l-6 12 1-9H5l8-11Z" />,
    arrow: <><path d="M7 17 17 7M7 7h10v10" /></>,
    upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M20 16.5v3A1.5 1.5 0 0 1 18.5 21h-13A1.5 1.5 0 0 1 4 19.5v-3" /></>,
    download: <><path d="M12 4v12m0 0 5-5m-5 5-5-5" /><path d="M4 17v3h16v-3" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.07 0l2-2A5 5 0 0 0 12 3.93l-1.15 1.15" /><path d="M14 11a5 5 0 0 0-7.07 0l-2 2A5 5 0 0 0 12 20.07l1.15-1.15" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
    wifi: <><path d="M5 12.55a11 11 0 0 1 14.08 0" /><path d="M8.5 16.1a5 5 0 0 1 7 0" /><path d="M12 20h.01" /><path d="M2 9a16 16 0 0 1 20 0" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8m-8 4h8" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M5.5 9A7 7 0 0 1 17 6l3 6M4 12l3 6a7 7 0 0 0 11.5-3" /></>,
  }
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name] ?? paths.file}
    </svg>
  )
}

function App() {
  const [connected, setConnected] = useState(false)
  const [channelOpen, setChannelOpen] = useState(false)
  const [roomCode, setRoomCode] = useState('')
  const [roomInput, setRoomInput] = useState(() => new URLSearchParams(window.location.search).get('room')?.toUpperCase() ?? '')
  const [peer, setPeer] = useState<Peer | null>(null)
  const [qrCode, setQrCode] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [transfer, setTransfer] = useState<Transfer | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const roomCodeRef = useRef('')
  const transferIsReceivingRef = useRef(false)
  const transferIsSendingRef = useRef(false)
  const transferSizeRef = useRef(0)
  const transferNameRef = useRef('')
  const transferMimeRef = useRef('')
  const socketRef = useRef<Socket | null>(null)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const dataChannelRef = useRef<RTCDataChannel | null>(null)
  const peerIdRef = useRef('')
  const remoteDescriptionReadyRef = useRef(false)
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  const currentTransferIdRef = useRef('')
  const pendingFileRef = useRef<File | null>(null)
  const acceptResolverRef = useRef<((accepted: boolean) => void) | null>(null)
  const completionResolverRef = useRef<((completed: boolean) => void) | null>(null)
  const batchAckRef = useRef<{ batch: number; resolve: () => void; reject: (error: Error) => void } | null>(null)
  const writableRef = useRef<WritableFile | null>(null)
  const receivedChunksRef = useRef<ArrayBuffer[]>([])
  const receivedBytesRef = useRef(0)
  const receivedBatchBytesRef = useRef(0)
  const receivedBatchChunksRef = useRef(0)
  const receivedBatchRef = useRef(0)
  const receiveQueueRef = useRef(Promise.resolve())

  const closePeerConnection = () => {
    dataChannelRef.current?.close()
    peerConnectionRef.current?.close()
    dataChannelRef.current = null
    peerConnectionRef.current = null
    peerIdRef.current = ''
    setChannelOpen(false)
    remoteDescriptionReadyRef.current = false
    pendingCandidatesRef.current = []
    currentTransferIdRef.current = ''
    pendingFileRef.current = null
    transferIsReceivingRef.current = false
    transferIsSendingRef.current = false
    acceptResolverRef.current?.(false)
    acceptResolverRef.current = null
    completionResolverRef.current?.(false)
    completionResolverRef.current = null
    batchAckRef.current?.reject(new Error('The peer disconnected.'))
    batchAckRef.current = null
    void writableRef.current?.abort().catch(() => undefined)
    writableRef.current = null
    receivedChunksRef.current = []
    receivedBytesRef.current = 0
    receivedBatchBytesRef.current = 0
    receivedBatchChunksRef.current = 0
    receivedBatchRef.current = 0
    setPeer(null)
    setTransfer(null)
  }

  useEffect(() => {
    const signalingOrigin = import.meta.env.VITE_SIGNALING_URL
      ? new URL(import.meta.env.VITE_SIGNALING_URL).origin
      : window.location.origin
    let iceServersPromise: Promise<RTCIceServer[]> | null = null
    const loadIceServers = () => {
      iceServersPromise ??= fetch(new URL('/ice-servers', `${signalingOrigin}/`))
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const result = await response.json() as { iceServers?: RTCIceServer[] }
          if (!Array.isArray(result.iceServers) || result.iceServers.length === 0) {
            throw new Error('The signaling service returned no ICE servers.')
          }
          return result.iceServers
        })
        .catch((cause: unknown) => {
          iceServersPromise = null
          throw cause
        })
      return iceServersPromise
    }
    const socket = io(import.meta.env.VITE_SIGNALING_URL ? signalingOrigin : undefined, {
      transports: import.meta.env.DEV ? ['polling'] : ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      timeout: 10_000,
    })
    socketRef.current = socket

    const createConnection = async (targetPeerId: string) => {
      const attachDataChannel = (channel: RTCDataChannel) => {
        dataChannelRef.current = channel
        channel.binaryType = 'arraybuffer'
        channel.onopen = () => {
          setError('')
          setChannelOpen(true)
        }
        channel.onclose = () => {
          setChannelOpen(false)
          if (currentTransferIdRef.current) {
            setTransfer((current) =>
              current && current.status === 'transferring'
                ? { ...current, status: 'error', message: 'Connection closed before the transfer finished.' }
                : current,
            )
          }
        }
        channel.onerror = () => setError('The peer-to-peer data channel encountered an error.')
        channel.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
          receiveQueueRef.current = receiveQueueRef.current
            .then(async () => {
              if (typeof event.data !== 'string') {
                await handleFileChunk(event.data)
                return
              }

              let message: Message
              try {
                message = JSON.parse(event.data) as Message
              } catch {
                throw new Error('Received an invalid transfer message.')
              }
              await handleTransferMessage(message)
            })
            .catch((cause: unknown) => {
              const message = cause instanceof Error ? cause.message : 'The transfer could not be processed.'
              const transferId = currentTransferIdRef.current
              setError(message)
              setTransfer((current) =>
                current ? { ...current, status: 'error', message } : current,
              )
              transferIsReceivingRef.current = false
              transferIsSendingRef.current = false
              pendingFileRef.current = null
              completionResolverRef.current?.(false)
              completionResolverRef.current = null
              batchAckRef.current?.reject(new Error(message))
              batchAckRef.current = null
              void writableRef.current?.abort().catch(() => undefined)
              writableRef.current = null
              receivedChunksRef.current = []
              if (dataChannelRef.current?.readyState === 'open') {
                dataChannelRef.current.send(JSON.stringify({
                  type: 'cancel',
                  transferId,
                  reason: message,
                }))
              }
              currentTransferIdRef.current = ''
            })
        }
      }

      if (peerConnectionRef.current) {
        return { connection: peerConnectionRef.current, attachDataChannel }
      }

      peerIdRef.current = targetPeerId
      const connection = new RTCPeerConnection({ iceServers: await loadIceServers() })
      peerConnectionRef.current = connection
      connection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', {
            toPeerId: targetPeerId,
            candidate: event.candidate.toJSON(),
          })
        }
      }
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === 'failed') {
          setError('The peer connection failed. Check that TURN is configured on the signaling server and try again; an interrupted transfer cannot resume.')
        }
      }
      connection.ondatachannel = (event) => attachDataChannel(event.channel)
      return { connection, attachDataChannel }
    }

    const handleFileChunk = async (data: ArrayBuffer) => {
      if (!currentTransferIdRef.current || !transferIsReceivingRef.current) {
        throw new Error('Unexpected file data was received.')
      }
      const chunk = new Uint8Array(data)
      if (chunk.byteLength > CHUNK_SIZE) {
        throw new Error('Received a file chunk larger than the supported size.')
      }
      const nextBytes = receivedBytesRef.current + chunk.byteLength
      if (nextBytes > transferSizeRef.current) {
        throw new Error('Received more data than the file size declared.')
      }
      if (writableRef.current) await writableRef.current.write(chunk)
      else receivedChunksRef.current.push(data)
      receivedBytesRef.current = nextBytes
      receivedBatchBytesRef.current += chunk.byteLength
      receivedBatchChunksRef.current += 1
    }

    const handleTransferMessage = async (message: Message) => {
      const channel = dataChannelRef.current
      if (!channel) throw new Error('The peer-to-peer channel is not ready.')

      if (message.type === 'file-offer') {
        if (
          typeof message.transferId !== 'string' ||
          typeof message.name !== 'string' ||
          !Number.isSafeInteger(message.size) ||
          message.size < 0 ||
          message.size > MAX_FILE_SIZE
        ) {
          throw new Error('The incoming file offer is invalid or exceeds the 2 GB limit.')
        }
        if (currentTransferIdRef.current && currentTransferIdRef.current !== message.transferId) {
          channel.send(JSON.stringify({
            type: 'reject',
            transferId: message.transferId,
            reason: 'The receiver is busy with another transfer.',
          } satisfies Message))
          return
        }
        currentTransferIdRef.current = message.transferId
        transferSizeRef.current = message.size
        transferNameRef.current = message.name
        transferMimeRef.current = message.mimeType || 'application/octet-stream'
        transferIsReceivingRef.current = false
        receivedChunksRef.current = []
        receivedBytesRef.current = 0
        receivedBatchBytesRef.current = 0
        receivedBatchChunksRef.current = 0
        receivedBatchRef.current = 0
        setTransfer({
          direction: 'receive',
          fileName: message.name,
          size: message.size,
          progress: 0,
          status: 'waiting',
        })
        return
      }

      if (message.transferId !== currentTransferIdRef.current) return

      if (message.type === 'accept' && transferIsSendingRef.current) {
        acceptResolverRef.current?.(true)
        acceptResolverRef.current = null
      } else if (message.type === 'reject') {
        acceptResolverRef.current?.(false)
        acceptResolverRef.current = null
        transferIsSendingRef.current = false
        pendingFileRef.current = null
        currentTransferIdRef.current = ''
        setTransfer((current) =>
          current ? { ...current, status: 'error', message: message.reason || 'The receiver declined the file.' } : current,
        )
      } else if (message.type === 'batch-end' && transferIsReceivingRef.current) {
        if (
          message.batch !== receivedBatchRef.current ||
          message.bytes !== receivedBatchBytesRef.current ||
          receivedBatchChunksRef.current < 1 ||
          receivedBatchChunksRef.current > CHUNKS_PER_BATCH
        ) {
          throw new Error('A file batch was incomplete or out of order.')
        }
        channel.send(JSON.stringify({
          type: 'batch-ack',
          transferId: message.transferId,
          batch: message.batch,
        } satisfies Message))
        receivedBatchRef.current += 1
        receivedBatchBytesRef.current = 0
        receivedBatchChunksRef.current = 0
        setTransfer((current) =>
          current
            ? { ...current, progress: transferSizeRef.current === 0 ? 1 : receivedBytesRef.current / transferSizeRef.current }
            : current,
        )
      } else if (message.type === 'batch-ack' && transferIsSendingRef.current) {
        if (batchAckRef.current?.batch === message.batch) {
          batchAckRef.current.resolve()
          batchAckRef.current = null
        }
      } else if (message.type === 'complete' && transferIsReceivingRef.current) {
        if (receivedBytesRef.current !== transferSizeRef.current) {
          throw new Error('The received file size does not match the original.')
        }
        if (writableRef.current) {
          await writableRef.current.close()
          writableRef.current = null
        } else {
          downloadReceivedFile(receivedChunksRef.current, transferNameRef.current, transferMimeRef.current)
          receivedChunksRef.current = []
        }
        channel.send(JSON.stringify({ type: 'complete-ack', transferId: message.transferId } satisfies Message))
        setTransfer((current) => current ? { ...current, progress: 1, status: 'complete' } : current)
        transferIsReceivingRef.current = false
        currentTransferIdRef.current = ''
      } else if (message.type === 'complete-ack' && transferIsSendingRef.current) {
        completionResolverRef.current?.(true)
        completionResolverRef.current = null
      } else if (message.type === 'cancel') {
        acceptResolverRef.current?.(false)
        acceptResolverRef.current = null
        completionResolverRef.current?.(false)
        completionResolverRef.current = null
        batchAckRef.current?.reject(new Error(message.reason || 'The sender cancelled the transfer.'))
        batchAckRef.current = null
        await writableRef.current?.abort()
        writableRef.current = null
        receivedChunksRef.current = []
        transferIsReceivingRef.current = false
        transferIsSendingRef.current = false
        pendingFileRef.current = null
        setTransfer((current) =>
          current ? { ...current, status: 'error', message: message.reason || 'The transfer was cancelled.' } : current,
        )
        currentTransferIdRef.current = ''
      }
    }

    const downloadReceivedFile = (chunks: ArrayBuffer[], fileName: string, mimeType: string) => {
      const blob = new Blob(chunks, { type: mimeType || 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }

    const startOffer = async (newPeer: Peer) => {
      if (peerConnectionRef.current) return
      setPeer(newPeer)
      try {
        const { connection, attachDataChannel } = await createConnection(newPeer.peerId)
        attachDataChannel(connection.createDataChannel('file-transfer', { ordered: true }))
        const offer = await connection.createOffer()
        await connection.setLocalDescription(offer)
        if (connection.localDescription) {
          socket.emit('signal-offer', {
            toPeerId: newPeer.peerId,
            description: connection.localDescription,
          })
        }
      } catch (cause) {
        const details = cause instanceof Error ? cause.message : 'unknown error'
        setError(`Could not load peer connection settings: ${details}. Configure TURN on the signaling server and retry.`)
      }
    }

    socket.on('connect', () => {
      setConnected(true)
      const savedRoomCode = roomCodeRef.current
      if (!savedRoomCode) return

      socket.emit('join-room', { roomCode: savedRoomCode, displayName: 'Nearby device' }, (result: JoinResult) => {
        if (!result.ok) {
          roomCodeRef.current = ''
          setRoomCode('')
          setError(result.error || 'Could not rejoin the room. Create a new room to continue.')
          return
        }
        const existingPeer = result.peers?.[0]
        if (existingPeer) setPeer(existingPeer)
        setError('')
      })
    })
    socket.on('disconnect', (reason: string) => {
      setConnected(false)
      closePeerConnection()
      setError('Signaling connection lost. Reconnecting; the current file transfer has stopped.')
      if (reason === 'io server disconnect') socket.connect()
    })
    socket.on('connect_error', (cause: Error) => {
      setConnected(false)
      setError(`Cannot reach the signaling server: ${cause.message}. Check that both app services are running.`)
    })
    socket.on('peer-joined', startOffer)
    socket.on('peer-left', () => {
      closePeerConnection()
      setError('The other device left the room. You can wait for it to reconnect.')
    })
    socket.on('signal-offer', async ({ fromPeerId, description }: { fromPeerId: string; description: RTCSessionDescriptionInit }) => {
      try {
        const { connection } = await createConnection(fromPeerId)
        await connection.setRemoteDescription(description)
        remoteDescriptionReadyRef.current = true
        for (const candidate of pendingCandidatesRef.current.splice(0)) {
          await connection.addIceCandidate(candidate)
        }
        const answer = await connection.createAnswer()
        await connection.setLocalDescription(answer)
        if (connection.localDescription) {
          socket.emit('signal-answer', { toPeerId: fromPeerId, description: connection.localDescription })
        }
      } catch (cause) {
        const details = cause instanceof Error ? cause.message : 'unknown error'
        setError(`Could not establish the peer connection: ${details}. Check the signaling and TURN configuration, then retry.`)
      }
    })
    socket.on('signal-answer', async ({ fromPeerId, description }: { fromPeerId: string; description: RTCSessionDescriptionInit }) => {
      try {
        if (fromPeerId !== peerIdRef.current || !peerConnectionRef.current) return
        await peerConnectionRef.current.setRemoteDescription(description)
        remoteDescriptionReadyRef.current = true
        for (const candidate of pendingCandidatesRef.current.splice(0)) {
          await peerConnectionRef.current.addIceCandidate(candidate)
        }
      } catch {
        setError('Could not complete the peer connection. Please retry.')
      }
    })
    socket.on('ice-candidate', async ({ fromPeerId, candidate }: { fromPeerId: string; candidate: RTCIceCandidateInit }) => {
      if (fromPeerId !== peerIdRef.current) return
      if (!remoteDescriptionReadyRef.current || !peerConnectionRef.current) {
        pendingCandidatesRef.current.push(candidate)
        return
      }
      try {
        await peerConnectionRef.current.addIceCandidate(candidate)
      } catch {
        setError('A network route could not be added. Please retry pairing.')
      }
    })
    socket.on('room-expired', () => {
      closePeerConnection()
      roomCodeRef.current = ''
      setRoomCode('')
      setError('This room expired. Create a new room to continue.')
    })

    return () => {
      socket.removeAllListeners()
      socket.disconnect()
      closePeerConnection()
      socketRef.current = null
    }
  }, [])

  const joinRoom = (requestedCode: string) => {
    const socket = socketRef.current
    if (!socket?.connected) {
      setError('Still connecting to the pairing server. Please try again in a moment.')
      return
    }
    const normalizedCode = requestedCode.trim().toUpperCase()
    setError('')
    socket.emit(
      'join-room',
      { roomCode: normalizedCode, displayName: 'Nearby device' },
      (result: JoinResult) => {
        if (!result.ok || !result.peerId) {
          setError(result.error || 'Could not join this room.')
          return
        }
        setQrCode('')
        roomCodeRef.current = normalizedCode
        setRoomCode(normalizedCode)
        setRoomInput(normalizedCode)
        if (result.peers?.length) {
          setPeer(result.peers[0])
        }
      },
    )
  }

  const createRoom = () => {
    try {
      joinRoom(makeRoomCode())
    } catch {
      setError('This browser cannot generate a secure room code. Open the app in a modern browser over HTTPS.')
    }
  }

  const copyRoomLink = async () => {
    const url = new URL(window.location.href)
    url.searchParams.set('room', roomCode)
    try {
      await navigator.clipboard.writeText(url.toString())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('Clipboard access was blocked. You can still share the room code manually.')
    }
  }

  useEffect(() => {
    if (!roomCode) return
    const url = new URL(window.location.href)
    url.searchParams.set('room', roomCode)
    let active = true
    void QRCode.toDataURL(url.toString(), { width: 176, margin: 1, color: { dark: '#17201d', light: '#ffffff' } })
      .then((dataUrl) => {
        if (active) setQrCode(dataUrl)
      })
      .catch(() => setError('Could not generate the room QR code.'))
    return () => {
      active = false
    }
  }, [roomCode])

  const startTransfer = async (file: File) => {
    const channel = dataChannelRef.current
    if (channel?.readyState !== 'open' || transfer || currentTransferIdRef.current) {
      setError('Wait until the other device is connected before choosing a file.')
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setError('Files larger than 2 GB are not supported.')
      return
    }

    let transferId: string
    try {
      transferId = makeTransferId()
    } catch {
      setError('This browser cannot generate a secure transfer ID. Open the app in a modern browser.')
      return
    }
    try {
      channel.send(JSON.stringify({
        type: 'file-offer',
        transferId,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
      } satisfies Message))
    } catch {
      setError('Could not send the file offer. Check that the other device is still connected.')
      return
    }

    currentTransferIdRef.current = transferId
    transferIsSendingRef.current = true
    pendingFileRef.current = file
    transferNameRef.current = file.name
    transferMimeRef.current = file.type
    setError('')
    setTransfer({ direction: 'send', fileName: file.name, size: file.size, progress: 0, status: 'waiting' })
    const accepted = await new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => {
        acceptResolverRef.current = null
        resolve(false)
      }, 90_000)
      acceptResolverRef.current = (value) => {
        window.clearTimeout(timeout)
        resolve(value)
      }
    })
    if (!accepted) {
      transferIsSendingRef.current = false
      pendingFileRef.current = null
      setTransfer((current) =>
        current?.direction === 'send' && current.status === 'waiting'
          ? { ...current, status: 'error', message: 'No response from the receiver. Send the offer again when ready.' }
          : current,
      )
      if (channel.readyState === 'open') {
        channel.send(JSON.stringify({
          type: 'cancel',
          transferId,
          reason: 'The receiver did not respond in time.',
        } satisfies Message))
      }
      currentTransferIdRef.current = ''
      return
    }

    setTransfer((current) => current ? { ...current, status: 'transferring' } : current)
    let offset = 0
    let batch = 0
    try {
      while (offset < file.size) {
        let batchBytes = 0
        const batchAck = new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            if (batchAckRef.current?.batch === batch) {
              batchAckRef.current = null
              reject(new Error('The receiver stopped acknowledging file data.'))
            }
          }, 60_000)
          batchAckRef.current = {
            batch,
            resolve: () => {
              window.clearTimeout(timeout)
              resolve()
            },
            reject: (cause) => {
              window.clearTimeout(timeout)
              reject(cause)
            },
          }
        })
        for (let count = 0; count < CHUNKS_PER_BATCH && offset < file.size; count += 1) {
          if (channel.readyState !== 'open') throw new Error('The peer disconnected during transfer.')
          if (channel.bufferedAmount > 1024 * 1024) {
            await new Promise<void>((resolve, reject) => {
              const onLow = () => {
                channel.removeEventListener('bufferedamountlow', onLow)
                channel.removeEventListener('close', onClose)
                resolve()
              }
              const onClose = () => {
                channel.removeEventListener('bufferedamountlow', onLow)
                reject(new Error('The peer disconnected during transfer.'))
              }
              channel.bufferedAmountLowThreshold = 256 * 1024
              channel.addEventListener('bufferedamountlow', onLow, { once: true })
              channel.addEventListener('close', onClose, { once: true })
              if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) onLow()
            })
          }
          const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()
          channel.send(chunk)
          offset += chunk.byteLength
          batchBytes += chunk.byteLength
        }
        channel.send(JSON.stringify({ type: 'batch-end', transferId, batch, bytes: batchBytes } satisfies Message))
        await batchAck
        batch += 1
        setTransfer((current) =>
          current ? { ...current, progress: file.size === 0 ? 1 : offset / file.size } : current,
        )
      }
      const completion = new Promise<boolean>((resolve) => {
        const timeout = window.setTimeout(() => {
          completionResolverRef.current = null
          resolve(false)
        }, 60_000)
        completionResolverRef.current = (completed) => {
          window.clearTimeout(timeout)
          resolve(completed)
        }
      })
      channel.send(JSON.stringify({ type: 'complete', transferId } satisfies Message))
      if (!(await completion)) throw new Error('The receiver did not confirm the saved file.')
      transferIsSendingRef.current = false
      pendingFileRef.current = null
      currentTransferIdRef.current = ''
      setTransfer((current) => current ? { ...current, progress: 1, status: 'complete' } : current)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The transfer failed.'
      if (channel.readyState === 'open') {
        channel.send(JSON.stringify({ type: 'cancel', transferId, reason: message } satisfies Message))
      }
      transferIsSendingRef.current = false
      pendingFileRef.current = null
      completionResolverRef.current?.(false)
      completionResolverRef.current = null
      batchAckRef.current = null
      currentTransferIdRef.current = ''
      setTransfer((current) => current ? { ...current, status: 'error', message } : current)
    }
  }

  const acceptTransfer = async () => {
    const channel = dataChannelRef.current
    const current = transfer
    if (channel?.readyState !== 'open' || !current || current.direction !== 'receive') return

    if (savePicker) {
      try {
        const handle = await savePicker({ suggestedName: current.fileName })
        writableRef.current = await handle.createWritable()
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setError('Could not open a save location. Try again or use a supported browser.')
        return
      }
    } else if (current.size > MEMORY_LIMIT) {
      setError(`This browser can only receive files up to ${formatBytes(MEMORY_LIMIT)} without direct-to-disk saving. Open this page in a browser with file saving support.`)
      return
    }

    receivedChunksRef.current = []
    receivedBytesRef.current = 0
    receivedBatchBytesRef.current = 0
    receivedBatchChunksRef.current = 0
    receivedBatchRef.current = 0
    transferIsReceivingRef.current = true
    channel.send(JSON.stringify({ type: 'accept', transferId: currentTransferIdRef.current } satisfies Message))
    setTransfer({ ...current, status: 'transferring', progress: 0 })
  }

  const declineTransfer = () => {
    dataChannelRef.current?.send(JSON.stringify({
      type: 'reject',
      transferId: currentTransferIdRef.current,
      reason: 'The receiver declined the file.',
    } satisfies Message))
    transferIsReceivingRef.current = false
    currentTransferIdRef.current = ''
    setTransfer(null)
  }

  const cancelTransfer = () => {
    const channel = dataChannelRef.current
    const id = currentTransferIdRef.current
    if (channel?.readyState === 'open' && id) {
      channel.send(JSON.stringify({ type: 'cancel', transferId: id, reason: 'The transfer was cancelled.' } satisfies Message))
    }
    acceptResolverRef.current?.(false)
    acceptResolverRef.current = null
    batchAckRef.current?.reject(new Error('The transfer was cancelled.'))
    batchAckRef.current = null
    void writableRef.current?.abort().catch(() => undefined)
    writableRef.current = null
    receivedChunksRef.current = []
    transferIsReceivingRef.current = false
    transferIsSendingRef.current = false
    pendingFileRef.current = null
    currentTransferIdRef.current = ''
    if (transferIsSendingRef.current === false && transfer?.direction === 'send') {
      setTransfer({ ...transfer, status: 'error', message: 'Transfer cancelled.' })
    } else {
      setTransfer(null)
    }
  }

  const resetTransfer = () => {
    setTransfer(null)
    setError('')
  }

  const onFileSelected = (file?: File) => {
    if (file) {
      void startTransfer(file).catch(() => {
        transferIsSendingRef.current = false
        pendingFileRef.current = null
        currentTransferIdRef.current = ''
        setTransfer((current) =>
          current?.direction === 'send'
            ? { ...current, status: 'error', message: 'The file could not be sent. Check the connection and try again.' }
            : current,
        )
        setError('The file could not be sent. Check the connection and try again.')
      })
    }
  }

  const readyToTransfer = Boolean(peer && channelOpen)
  const percentage = transfer ? Math.round(transfer.progress * 100) : 0

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="SwiftDrop home">
          <span className="brand-mark"><Icon name="bolt" size={19} /></span>
          <span>swift<span>drop</span></span>
        </a>
        <div className="topbar-right">
          <span className={`server-status ${connected ? 'is-online' : ''}`}>
            <span className="status-dot" />
            {connected ? 'Ready to connect' : 'Connecting'}
          </span>
          <a className="help-link" href="#how-it-works">How it works <Icon name="arrow" size={15} /></a>
        </div>
      </header>

      <main>
        <section className="hero-section">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-line" /> FILES, WITHOUT THE FUSS</div>
            <h1>Move big files.<br /><span>Not through the cloud.</span></h1>
            <p className="hero-description">A private, direct connection between your devices. No uploads, no cables, no app to install.</p>
            <div className="trust-row">
              <span><Icon name="shield" size={16} /> Peer-to-peer</span>
              <span><Icon name="wifi" size={16} /> Same Wi-Fi is fastest</span>
              <span><Icon name="bolt" size={16} /> No account needed</span>
            </div>
          </div>

          <div className="connect-card">
            {!roomCode ? (
              <>
                <div className="card-heading">
                  <span className="step-number">01</span>
                  <div><h2>Make a connection</h2><p>Create a room or enter a code from your other device.</p></div>
                </div>
                <button className="primary-button create-button" type="button" onClick={createRoom} disabled={!connected}>
                  <span className="button-icon"><Icon name="plus" size={18} /></span>
                  Create a room
                  <Icon name="arrow" size={17} />
                </button>
                <div className="divider"><span>OR JOIN WITH A CODE</span></div>
                <form className="join-form" onSubmit={(event) => { event.preventDefault(); joinRoom(roomInput) }}>
                  <label className="sr-only" htmlFor="room-code">8-character room code</label>
                  <input
                    id="room-code"
                    value={roomInput}
                    onChange={(event) => setRoomInput(event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8))}
                    placeholder="ENTER ROOM CODE"
                    maxLength={8}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button className="join-button" type="submit" disabled={!connected || roomInput.length !== 8}>Join <Icon name="arrow" size={16} /></button>
                </form>
                {error && <p className="inline-error" role="alert">{error}</p>}
                <p className="card-footnote"><span className="secure-dot" /> Your files travel directly between devices.</p>
              </>
            ) : (
              <div className="room-panel">
                <div className="card-heading">
                  <span className="step-number">02</span>
                  <div><h2>{peer ? 'You’re connected' : 'Your room is ready'}</h2><p>{peer ? `${peer.name} joined. You can send a file now.` : 'Scan the QR code or share the room code.'}</p></div>
                </div>
                <div className="room-content">
                  <div className="qr-frame">
                    {qrCode ? <img src={qrCode} alt={`QR code to join room ${roomCode}`} /> : <div className="qr-placeholder"><span /></div>}
                    <span>SCAN TO JOIN</span>
                  </div>
                  <div className="room-share">
                    <span className="field-label">ROOM CODE</span>
                    <div className="room-code">{roomCode.split('').join(' ')}</div>
                    <button className="copy-button" type="button" onClick={() => void copyRoomLink()}>
                      <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? 'Link copied' : 'Copy invite link'}
                    </button>
                    <div className={`peer-status ${peer ? 'connected' : ''}`}>
                      <span className="status-dot" />
                      {peer ? `Connected to ${peer.name}` : 'Waiting for your other device…'}
                    </div>
                  </div>
                </div>
                {error && <p className="inline-error" role="alert">{error}</p>}
                {peer && (
                  <div
                    className={`send-area ${isDragOver ? 'drag-over' : ''} ${!readyToTransfer ? 'is-disabled' : ''}`}
                    onDragOver={(event) => { event.preventDefault(); setIsDragOver(true) }}
                    onDragLeave={() => setIsDragOver(false)}
                    onDrop={(event) => {
                      event.preventDefault()
                      setIsDragOver(false)
                      onFileSelected(event.dataTransfer.files[0])
                    }}
                  >
                    {transfer ? (
                      <div className="transfer-card">
                        <div className="transfer-file-icon"><Icon name={transfer.status === 'complete' ? 'check' : transfer.direction === 'send' ? 'upload' : 'download'} size={19} /></div>
                        <div className="transfer-main">
                          <div className="transfer-title-row">
                            <span className="transfer-name">{transfer.fileName}</span>
                            {transfer.status === 'transferring' && <span className="transfer-percent">{percentage}%</span>}
                          </div>
                          <span className="transfer-meta">
                            {transfer.message || (transfer.status === 'waiting'
                              ? transfer.direction === 'receive' ? 'Waiting for your approval' : 'Waiting for the receiver'
                              : transfer.status === 'complete' ? `Transfer complete · ${formatBytes(transfer.size)}`
                                : transfer.status === 'transferring' ? `${formatBytes(Math.round(transfer.size * transfer.progress))} of ${formatBytes(transfer.size)}`
                                  : 'Transfer stopped')}
                          </span>
                          {(transfer.status === 'transferring' || transfer.status === 'complete') && (
                            <div className="progress-track"><span style={{ width: `${percentage}%` }} /></div>
                          )}
                        </div>
                        {transfer.status === 'waiting' && transfer.direction === 'receive' ? (
                          <div className="transfer-actions">
                            <button className="accept-button" type="button" disabled={!savePicker && transfer.size > MEMORY_LIMIT} onClick={() => void acceptTransfer()} title={!savePicker && transfer.size > MEMORY_LIMIT ? 'This browser cannot save a file this large.' : undefined}>
                              {!savePicker && transfer.size > MEMORY_LIMIT ? 'Too large' : 'Accept'}
                            </button>
                            <button className="icon-button" type="button" onClick={declineTransfer} aria-label="Decline file"><Icon name="close" size={17} /></button>
                            {!savePicker && transfer.size > MEMORY_LIMIT && (
                              <span className="transfer-limit">This browser can only receive files up to {formatBytes(MEMORY_LIMIT)}. Open the link in a browser with direct-to-disk saving.</span>
                            )}
                          </div>
                        ) : transfer.status === 'transferring' ? (
                          <button className="icon-button" type="button" onClick={cancelTransfer} aria-label="Cancel transfer"><Icon name="close" size={17} /></button>
                        ) : transfer.status === 'complete' || transfer.status === 'error' ? (
                          <button className="icon-button" type="button" onClick={resetTransfer} aria-label="Dismiss transfer"><Icon name="close" size={17} /></button>
                        ) : null}
                      </div>
                    ) : (
                      <label className="drop-label">
                        <span className="upload-icon"><Icon name="upload" size={21} /></span>
                        <span><strong>Choose a video to send</strong><small>or drop a file here · up to 2 GB (browser limits apply)</small></span>
                        <input type="file" accept="video/*,.mp4,.mov,.m4v,.mkv,.webm" disabled={!readyToTransfer} onChange={(event) => { onFileSelected(event.target.files?.[0]); event.currentTarget.value = '' }} />
                      </label>
                    )}
                  </div>
                )}
                {!peer && <p className="waiting-note"><span className="pulse-dot" /> Keep this page open while the other device joins.</p>}
                {peer && !savePicker && <p className="memory-note">{getLargeFileSaveHint()}</p>}
                <button className="leave-room" type="button" onClick={() => {
                  socketRef.current?.emit('leave-room')
                  closePeerConnection()
                  roomCodeRef.current = ''
                  setRoomCode('')
                  setQrCode('')
                }}>Leave room</button>
              </div>
            )}
          </div>
        </section>

        <section className="steps-section" id="how-it-works">
          <div className="section-title"><span className="eyebrow"><span className="eyebrow-line" /> SIMPLE BY DESIGN</span><h2>Three steps. That's the whole thing.</h2></div>
          <div className="steps-grid">
            <article className="step-card"><div className="step-icon purple"><Icon name="plus" size={20} /></div><span className="step-caption">01 / PAIR</span><h3>Open a room</h3><p>Create a private room, then share its code or scan the QR from your other device.</p></article>
            <article className="step-card"><div className="step-icon green"><Icon name="link" size={20} /></div><span className="step-caption">02 / CONNECT</span><h3>Connect directly</h3><p>Your browsers make a secure peer-to-peer connection. The server only helps them meet.</p></article>
            <article className="step-card"><div className="step-icon yellow"><Icon name="upload" size={20} /></div><span className="step-caption">03 / SEND</span><h3>Move your file</h3><p>Approve the incoming file on the receiving device. Your file isn't stored on our server.</p></article>
          </div>
        </section>
      </main>
      <footer className="footer"><a className="brand footer-brand" href="/"><span className="brand-mark"><Icon name="bolt" size={15} /></span><span>swift<span>drop</span></span></a><span>Direct device-to-device transfer. Nothing stored in the cloud.</span><span className="footer-secure"><Icon name="shield" size={14} /> Private by design</span></footer>
    </div>
  )
}

export default App
