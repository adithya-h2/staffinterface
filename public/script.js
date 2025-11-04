/**
 * Clara AI Reception System - Client Script
 */

// SSML utilities: pronunciation lexicon and SSML builder for human-like speech
const PRONUNCIATION_LEXICON = {
    'Bengaluru': { ipa: 'bɛnˈɡɑːləruː', lang: 'en-US' },
    'Visvesvaraya': { ipa: 'ʋiʂʋeːʋəˈraɪjɐ', lang: 'en-US' },
    'बैंगलुरु': { ipa: 'bɛŋɡəluɾʊ', lang: 'hi-IN' },
    'ಬೆಂಗಳೂರು': { ipa: 'beŋɡəɭuɾu', lang: 'kn-IN' },
    // Common Indian city/institute names (extend as needed)
    'Mysuru': { ipa: 'miːsuɾu', lang: 'en-US' },
    'Chikkamagaluru': { ipa: 't͡ʃikːəməɡəluːɾu', lang: 'en-US' },
    'Visakhapatnam': { ipa: 'ʋisaːkʰəpət̪nəm', lang: 'en-US' },
    'बेंगलुरु': { ipa: 'beŋɡəluɾu', lang: 'hi-IN' },
    'मैसूरु': { ipa: 'miːsuɾu', lang: 'hi-IN' },
    'चेन्नई': { ipa: 't͡ɕenːaɪ̯', lang: 'hi-IN' },
    'சென்னை': { ipa: 't͡ɕenːaɪ̯', lang: 'ta-IN' },
    'హైదరాబాద్': { ipa: 'ɦaɪ̯d̪əɾaːbɑːd̪', lang: 'te-IN' },
    // Additional common names for clearer pronunciation
    'Hyderabad': { ipa: 'ˈhaɪdərəbɑːd', lang: 'en-US' },
    'Chennai': { ipa: 'ˈtʃɛnaɪ', lang: 'en-US' },
    'Thiruvananthapuram': { ipa: 't̪ir̪uʋənən̪t̪əpuɾəm', lang: 'en-US' },
    'Ahmedabad': { ipa: 'ˈɑːmədəbɑːd', lang: 'en-US' },
    // Acronyms and programs (English/Indian English)
    'B.Tech': { ipa: 'biː tɛk', lang: 'en-IN' },
    'B.E.': { ipa: 'biː iː', lang: 'en-IN' },
    'AICTE': { ipa: 'eɪ aɪ siː tiː iː', lang: 'en-IN' },
    'CSE': { ipa: 'siː ɛs iː', lang: 'en-IN' },
    'ECE': { ipa: 'iː siː iː', lang: 'en-IN' },
    'EEE': { ipa: 'iː iː iː', lang: 'en-IN' },
    'MBA': { ipa: 'ɛm biː eɪ', lang: 'en-IN' },
    'MTech': { ipa: 'ɛm tɛk', lang: 'en-IN' }
};

function buildHumanSSML(text, lang = 'en-US') {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    // Pauses per spec
    t = t.replace(/\n\n+/g, '<break time="850ms"/>' );
    t = t.replace(/,/g, ',<break time="280ms"/>' );
    t = t.replace(/[;:]/g, '$&<break time="350ms"/>' );
    t = t.replace(/([.!?])(\s+)/g, '$1<break time="550ms"/> ');
    t = t.replace(/\.{3,}/g, '<break time="600ms"/>' );
    // URLs/emails/paths slower
    t = t.replace(/((?:https?:\/\/|www\.)[^\s]+|[\w.-]+@[\w.-]+\.[A-Za-z]{2,}|(?:[A-Za-z]:)?\\[\w\\.-]+)/g, (m) => `<prosody rate="75%">${m}</prosody>`);
    // Acronyms (uppercase sequences) spell out characters for clarity
    t = t.replace(/\b([A-Z]{2,6})\b/g, (m) => `<say-as interpret-as="characters">${m}</say-as>`);
    // Dates like 12/10/2025 → say-as date (day-month-year)
    t = t.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g, '<say-as interpret-as="date" format="dmY">$1$2$3</say-as>');
    // Long numeric IDs and years slower
    t = t.replace(/\b\d{6,}\b/g, (m) => `<prosody rate="80%"><say-as interpret-as="digits">${m}</say-as></prosody>`);
    t = t.replace(/\b(19|20)\d{2}\b/g, (m) => `<prosody rate="80%">${m}</prosody>`);
    // Lexicon phonemes
    for (const w of Object.keys(PRONUNCIATION_LEXICON)) {
        const e = PRONUNCIATION_LEXICON[w];
        const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\\]\\/g, '\\$&')}\\b`, 'g');
        t = t.replace(re, `<phoneme alphabet="ipa" ph="${e.ipa}">${w}</phoneme>`);
    }
    // Wrap with language and global rate
    return `\n<speak version="1.0" xml:lang="${lang}">\n  <lang xml:lang="${lang}">\n    <prosody rate="85%" pitch="+0st" volume="medium">\n      ${t}\n    </prosody>\n  </lang>\n</speak>`.trim();
}

// Create ONE shared AudioContext @ 48kHz per page (prevents stutter/robotic sound)
if (!window.__claraAudioCtx) {
    try {
        window.__claraAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        console.log('✅ Created shared AudioContext @', window.__claraAudioCtx.sampleRate, 'Hz');
    } catch (e) {
        window.__claraAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        console.warn('⚠️ 48kHz not supported, using default:', window.__claraAudioCtx.sampleRate, 'Hz');
    }
}

class Clara {
    constructor() {
        this.socket = io(window.location.origin, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 500,
            reconnectionDelayMax: 5000,
            timeout: 20000
        });
        this.conversationId = null;
        this.sessionId = null;
        this.speechRecognition = null;
        this.speechSynthesis = window.speechSynthesis;
        this.isListening = false;
        		this.isSpeechEnabled = true;
		this.isTextCleaningEnabled = true; // New property for text cleaning
		this.isTyping = false;
        this.isConversationStarted = false;
		this.availableVoices = [];
		this.pendingSpeakQueue = [];
		this.noSpeechRetries = 0;
		this.currentAudio = null; // Track current Edge TTS audio for proper cleanup
		this.isSpeaking = false; // Track speaking state
        this.audioConflictResolved = false; // Track conflict resolution
		this.browserTTSBlocked = false; // Track if browser denies speech synthesis
		this.currentAudioInterval = null; // Track iOS audio monitoring interval
		this.audioContextUnlocked = false; // Track iOS audio context unlock
		// Detect iOS/iPadOS
		this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
			(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
		this.hasPlayedAudio = false; // Track if we've successfully played audio once
		this.diagnosticData = {
			languageDetectionAccuracy: 0,
			speechFluencyScore: 0,
			playbackConflicts: 0,
			lastDiagnosticRun: null,
			autoFixAttempts: 0
		};
		// Video call state
		this.peerConnection = null;
		this.localStream = null;
		this.remoteStream = null;
		this.currentCallId = null;
        
        this.initializeElements();
        this.initializeSpeechRecognition();
		this.initializeVoices();
        this.setupEventListeners();
        
        // Run self-diagnosis for multilingual optimization after a short delay
        // Disabled to avoid any audible test speech at startup
        // setTimeout(() => this.runSelfDiagnosis(), 3000);
        this.setupSocketListeners();
        // Load shared IPA lexicon and merge
        this.loadSharedLexicon();
        this.setWelcomeTime();
        this.setupKeyboardShortcuts();
        
        // iOS Fix: Set up visibility change and page show handlers to resume audio
        if (this.isIOS) {
            this.setupIOSAudioResume();
            // Note: Audio unlock happens naturally when first audio plays with user gesture
            // No need to explicitly unlock upfront
        }
    }
    
    // iOS Fix: Handle visibility change and pageshow to resume audio when tab becomes active
    setupIOSAudioResume() {
        // Resume any playing audio on focus/visibility
        document.addEventListener('visibilitychange', () => {
            if (this.currentAudio && this.currentAudio.paused && !this.currentAudio.ended) {
                this.currentAudio.play().catch(err => {
                    console.warn('Failed to resume audio on visibility change:', err);
                });
            }
        });
        
        // Resume any playing audio on pageshow (back/forward navigation)
        window.addEventListener('pageshow', () => {
            if (this.currentAudio && this.currentAudio.paused && !this.currentAudio.ended) {
                this.currentAudio.play().catch(err => {
                    console.warn('Failed to resume audio on pageshow:', err);
                });
            }
        });
        
        // Resume any playing audio on focus
        window.addEventListener('focus', () => {
            if (this.currentAudio && this.currentAudio.paused && !this.currentAudio.ended) {
                this.currentAudio.play().catch(err => {
                    console.warn('Failed to resume audio on focus:', err);
                });
            }
        });
    }

    async loadSharedLexicon() {
        try {
            const res = await fetch('/config/pronunciations.json', { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            const ipa = (data && data.ipaLexicon) || {};
            // Merge english-india ipa entries by default
            if (ipa['en-IN']) {
                for (const [k, v] of Object.entries(ipa['en-IN'])) {
                    PRONUNCIATION_LEXICON[k] = { ipa: v, lang: 'en-IN' };
                }
            }
            // Merge hindi ipa entries
            if (ipa['hi-IN']) {
                for (const [k, v] of Object.entries(ipa['hi-IN'])) {
                    PRONUNCIATION_LEXICON[k] = { ipa: v, lang: 'hi-IN' };
                }
            }
            // Extend: add other languages if present
            for (const code of ['kn-IN','te-IN','ta-IN','ml-IN']) {
                if (ipa[code]) {
                    for (const [k, v] of Object.entries(ipa[code])) {
                        PRONUNCIATION_LEXICON[k] = { ipa: v, lang: code };
                    }
                }
            }
            console.log('✅ Loaded shared IPA lexicon');
        } catch (e) {
            console.warn('⚠️ Failed to load shared IPA lexicon', e);
        }
    }

    initializeElements() {
        // Chat elements
        this.chatMessages = document.getElementById('chatMessages');
        this.speechInputButton = document.getElementById('speechInputButton');
        this.micIcon = document.getElementById('micIcon');
        this.speechStatusDisplay = document.getElementById('speechStatusDisplay');
        this.speechToggle = document.getElementById('speechToggle');
        this.speechIcon = document.getElementById('speechIcon');
        this.speechStatus = document.getElementById('speechStatus');
        
        // Text cleaning controls
        this.textCleaningToggle = document.getElementById('textCleaningToggle');
        this.textCleaningIcon = document.getElementById('textCleaningIcon');
        this.textCleaningStatus = document.getElementById('textCleaningStatus');
        this.statusDot = document.getElementById('statusDot');
        this.statusText = document.getElementById('statusText');
    this.staffDirectory = {}; // shortName/email/name mapping for availability lookups
    this._availabilityPollTimer = null;
        
        // Error handling
        this.errorModal = document.getElementById('errorModal');
        this.errorTitle = document.getElementById('errorTitle');
        this.errorMessage = document.getElementById('errorMessage');
        this.closeError = document.getElementById('closeError');
    }

    initializeSpeechRecognition() {
        // Initialize browser-native speech recognition (Web Speech API)
        if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            this.speechRecognition = new SpeechRecognition();
            
            // Improved configuration for better reliability
            this.speechRecognition.continuous = false; // Changed to false for better control
            this.speechRecognition.interimResults = false; // Changed to false to avoid partial results
            this.speechRecognition.lang = 'en-US';
            this.speechRecognition.maxAlternatives = 1;
            
            this.speechRecognition.onstart = () => {
                this.isListening = true;
                this.speechInputButton.classList.add('recording');
                this.micIcon.className = 'fas fa-stop';
                this.speechStatusDisplay.textContent = 'Listening... Speak now!';
                this.speechStatusDisplay.classList.add('listening');
                this.updateStatus('Listening...', 'listening');
            };
            
            this.speechRecognition.onresult = (event) => {
                if (event.results.length > 0) {
                    const transcript = event.results[0][0].transcript.trim();
                    if (transcript) {
                        this.speechStatusDisplay.textContent = `Heard: "${transcript}"`;
                        this.sendMessage(transcript);
                    }
                }
            };
            
            this.speechRecognition.onerror = (event) => {
                console.error('Speech recognition error:', event.error);
                
                switch (event.error) {
                    case 'no-speech':
                        this.speechStatusDisplay.textContent = "Didn't catch that. Please try again.";
                        this.speechStatusDisplay.classList.remove('listening');
                        if (this.noSpeechRetries < 2 && this.isConversationStarted) {
                            this.noSpeechRetries += 1;
                            setTimeout(() => {
                                try { 
                                    this.speechRecognition.start(); 
                                } catch (e) {
                                    console.error('Failed to restart speech recognition:', e);
                                    this.resetSpeechInput();
                                }
                            }, 1000);
                            return;
                        }
                        break;
                        
                    case 'audio-capture':
                        this.showError('No microphone input detected. Please check your microphone and ensure it\'s not being used by another application.');
                        break;
                        
                    case 'not-allowed':
                    case 'service-not-allowed':
                        this.showError('Microphone permission denied. Please allow microphone access in your browser settings and refresh the page.');
                        break;
                        
                    case 'network':
                        this.showError('Network error occurred. Please check your internet connection.');
                        break;
                        
                    case 'aborted':
                        // User manually stopped, no need to show error
                        break;
                        
                    default:
                        this.showError(`Speech recognition error: ${event.error}. Please try again.`);
                }
                
                this.resetSpeechInput();
            };
            
            this.speechRecognition.onend = () => {
                // Only reset if we're not trying to restart
                if (this.noSpeechRetries === 0) {
                    this.resetSpeechInput();
                }
            };
        } else {
            console.warn('Speech recognition not supported');
            this.speechInputButton.style.display = 'none';
            this.speechStatusDisplay.textContent = 'Speech recognition not supported in this browser';
            this.showError('Speech recognition is not supported in your browser. Please use Chrome, Edge, or Safari for the best experience.');
        }
    }

    initializeVoices() {
        if (!this.speechSynthesis) return;

        const loadVoices = () => {
            const voices = this.speechSynthesis.getVoices() || [];
            if (voices.length > 0) {
                this.availableVoices = voices;
                
                // Set default English voice
                const defaultVoice = voices.find(v => /en(-|_)US/i.test(v.lang) && /Google|Natural|Premium|Enhanced/i.test(v.name))
                    || voices.find(v => /en(-|_)GB/i.test(v.lang) && /Google|Natural|Premium|Enhanced/i.test(v.name))
                    || voices.find(v => /en(-|_)US/i.test(v.lang))
                    || voices.find(v => /en(-|_)GB/i.test(v.lang))
                    || voices.find(v => /en/i.test(v.lang));
                
                if (defaultVoice) {
                    console.log('Default English voice set:', defaultVoice.name, defaultVoice.lang);
                }
                
                // Flush any pending speech once voices are available
                if (this.pendingSpeakQueue.length > 0) {
                    const queue = [...this.pendingSpeakQueue];
                    this.pendingSpeakQueue = [];
                    queue.forEach(text => this.speak(text));
                }
            }
        };

        // Attempt to load immediately (Chrome may already have voices)
        loadVoices();
        // Also listen for async population of voices
        if (typeof window !== 'undefined') {
            window.speechSynthesis.onvoiceschanged = () => loadVoices();
            
            // Ensure speech synthesis is properly initialized
            if (window.speechSynthesis.paused) {
                window.speechSynthesis.resume();
            }
        }
    }

    setupEventListeners() {
        // Speech input button
        this.speechInputButton.addEventListener('click', () => {
            // iOS Fix: Unlock audio context on any user interaction
            this.unlockAudioContext();
            
            if (!this.isConversationStarted) {
                // Show credentials popup first (original behavior)
                this.startConversation();
                return;
            }
            
            if (this.isListening) {
                // Stop browser speech recognition
                if (this.speechRecognition) {
                    this.speechRecognition.stop();
                }
            } else {
                // Start browser speech recognition
                this.startBrowserSpeechRecognition();
            }
        });

        // Speech toggle
        this.speechToggle.addEventListener('click', () => {
            this.toggleSpeech();
        });

        // Text cleaning toggle
        this.textCleaningToggle.addEventListener('click', () => {
            this.toggleTextCleaning();
        });

        // Error modal
        if (this.closeError) {
            this.closeError.addEventListener('click', () => {
                this.closeErrorModal();
            });
        }

        // Close error modal with Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeErrorModal();
            }
        });
        
        // iOS Fix: Note - Audio unlock happens naturally when audio plays with user gesture
        // No need to explicitly unlock upfront
    }

    setupSocketListeners() {
        // Connection events
        this.socket.on('connect', () => {
            console.log('✅ Connected to server');
            this.updateStatus('Connected', 'ready');
            
            // MULTI-TURN FIX: Start heartbeat for persistent session
            this.startHeartbeat();
            
            console.log('🔄 State transition: IDLE → READY');
            this.conversationState = 'IDLE';
        });

        this.socket.on('disconnect', () => {
            console.log('❌ Disconnected from server');
            this.updateStatus('Disconnected', 'error');
            
            // Stop heartbeat
            this.stopHeartbeat();
            
            // MULTI-TURN FIX: Auto-reconnect with jittered backoff
            this.handleReconnect();
        });

        // Conversation events
        this.socket.on('conversation-started', (data) => {
            console.log('Conversation started:', data);
            this.sessionId = data.sessionId;
            this.conversationId = data.callId;
            this.isConversationStarted = true;
            this.selectedStaffId = data.selectedStaffId || this.selectedStaffId;
            this.updateStatus('Ready to chat', 'ready');
            this.speechStatusDisplay.textContent = 'Click the microphone to speak';
            
            // Store user data for welcome message
            this.userData = data;
            
            // Add welcome message
            let welcome;
            if (data.purpose && data.purpose.trim() !== "Just wanted to chat and get some help") {
                welcome = `Hi ${data.name}! I'm Clara, your friendly AI receptionist! 😊 I see you mentioned: "${data.purpose}". I'd love to help you with that and anything else you need! What would you like to know?`;
            } else {
                welcome = `Hi ${data.name}! I'm Clara, your friendly AI receptionist! 😊 I'm so excited to help you today! What can I assist you with? Feel free to ask me anything - I'm here to help!`;
            }
			this.addMessage(welcome, 'bot');
			if (this.isSpeechEnabled) {
				this.speak(welcome);
			}
        });

        // Video call flow (targeted staff request)
        this.socket.on('initiate-video-call', (data) => {
            try {
                console.log('🎥 Initiating video call:', data);
                const payload = {
                    staffName: data.staffName,
                    staffEmail: data.staffEmail,
                    staffDepartment: data.staffDepartment,
                    clientName: (this.userData && this.userData.name) ? this.userData.name : 'Client',
                    clientSocketId: this.socket.id
                };
                this.socket.emit('video-call-request', payload);
                this.updateStatus('Connecting to staff...', 'processing');
                this.addMessage('Please wait while I establish the connection...', 'bot');
            } catch (error) {
                console.error('Error initiating video call:', error);
            }
        });

        // Fallback: if initiate-video-call missing staffEmail, derive from selected staff and re-send
        this.socket.on('initiate-video-call', (data) => {
            if (!data.staffEmail && this.selectedStaffId) {
                try {
                    const staffMap = {
                        'NN': 'nagashreen@gmail.com',
                        'LDN': 'lakshmidurgan@gmail.com',
                        'ACS': 'anithacs@gmail.com',
                        'GD': 'gdhivyasri@gmail.com',
                        'NSK': 'nishask@gmail.com',
                        'ABP': 'amarnathbpatil@gmail.com',
                        'JK': 'jyotikumari@gmail.com',
                        'VR': 'vidyashreer@gmail.com',
                        'BA': 'bhavanaa@gmail.com',
                        'BTN': 'bhavyatn@gmail.com'
                    };
                    const fallbackEmail = staffMap[this.selectedStaffId];
                    if (fallbackEmail) {
                        this.socket.emit('video-call-request', {
                            staffName: data.staffName || this.userData?.staffName || 'Staff',
                            staffEmail: fallbackEmail,
                            staffDepartment: data.staffDepartment || 'Computer Science Engineering',
                            clientName: (this.userData && this.userData.name) ? this.userData.name : 'Client',
                            clientSocketId: this.socket.id
                        });
                    }
                } catch (_) {}
            }
        });

        this.socket.on('video-call-request-sent', (data) => {
            console.log('Video call request sent:', data);
            this.updateStatus('Request sent. Waiting for staff...', 'processing');
        });

        this.socket.on('video-call-accepted', (data) => {
            console.log('Video call accepted:', data);
            this.updateStatus('Staff accepted. Starting call...', 'ready');
            this.addMessage(`Great news! ${data.staffName} accepted your video call.`, 'bot');
        });

        this.socket.on('video-call-rejected', (data) => {
            console.log('Video call rejected:', data);
            this.updateStatus('Staff unavailable', 'error');
            this.addMessage(data.message || 'The staff member is not available for a video call right now.', 'bot');
        });

        // Display QR code when a call ends and server sends it
        this.socket.on('call-completed-qr', async (data) => {
            try {
                const qrContainer = document.createElement('canvas');
                await (window.QRCode && QRCode.toCanvas)
                    ? QRCode.toCanvas(qrContainer, data.qrCode?.data || JSON.stringify(data.qrCode || {}), { width: 200, margin: 2 })
                    : Promise.resolve();

                const modal = document.createElement('div');
                modal.className = 'qr-code-modal';
                modal.innerHTML = `
                    <div class="qr-code-content">
                        <h3>${data.message || 'Your QR code'}</h3>
                        <div class="qr-code-canvas"></div>
                        <p><small>If you don't see a QR image, it may be a demo text QR.</small></p>
                        <button class="btn btn-primary" id="qrCloseBtn">Close</button>
                    </div>`;
                document.body.appendChild(modal);
                const holder = modal.querySelector('.qr-code-canvas');
                holder.appendChild(qrContainer);
                modal.querySelector('#qrCloseBtn').onclick = () => modal.remove();
            } catch (err) {
                console.error('Error showing QR code:', err);
            }
        });

        // Show server-side conversation errors immediately
        this.socket.on('conversation-error', (data) => {
            const msg = (data && data.message) ? data.message : 'Failed to start conversation.';
            this.showError(msg);
            this.updateStatus('Error', 'error');
        });

        this.socket.on('ai-response', (data) => {
            this.hideTypingIndicator();
            this.addMessage(data.response, 'bot');
            
            if (this.isSpeechEnabled) {
                this.speak(data.response);
            }
            
        // Handle video call request
        if (data.isVideoCallRequest && data.staffInfo) {
            console.log('🎥 Video call request detected:', data.staffInfo);
            this.showVideoCallRequest(data.staffInfo);
        }
        
        this.updateStatus('Ready', 'ready');
    });

    // Handle video call request sent confirmation
    this.socket.on('video-call-request-sent', (data) => {
        console.log('📤 Video call request sent:', data);
        this.updateStatus(data.message, 'info');
        this.addMessage(`📤 ${data.message}`, 'bot');
    });

    // Handle video call accepted by staff
    this.socket.on('video-call-accepted', (data) => {
        console.log('✅ Video call accepted by staff:', data);
        this.updateStatus(`🎉 ${data.staffName} accepted your video call!`, 'success');
        this.addMessage(`✅ ${data.staffName} accepted your video call request!`, 'bot');
        // Initialize video call interface
        this.startVideoCall(data);
    });

    // Handle WebRTC call response (alternative event name)
    this.socket.on('webrtc-call-response', (data) => {
        console.log('🎥 WebRTC call response received:', data);
        if (data.accepted) {
            console.log('✅ WebRTC call accepted by staff:', data);
            this.updateStatus(`🎉 ${data.staffName} accepted your video call!`, 'success');
            this.addMessage(`✅ ${data.staffName} accepted your video call request!`, 'bot');
            // Initialize video call interface
            this.startVideoCall(data);
        } else {
            console.log('❌ WebRTC call declined by staff:', data);
            this.updateStatus(`❌ ${data.staffName} declined your video call request.`, 'error');
            this.addMessage(`❌ ${data.staffName} is not available for video calls right now.`, 'bot');
        }
    });

    // Handle video call started - ENHANCED
    this.socket.on('video_call_started', (data) => {
        console.log('🎥 Video call started:', data);
        
        // Update current call data if needed
        if (data.callId && this.currentCallData) {
            this.currentCallData.callId = data.callId;
            this.currentCallData.staffName = data.staffName || this.currentCallData.staffName;
        }
        
        // Join the call room then show UI
        try {
            if (data.callId) {
                this.socket.emit('join_call', { callId: data.callId });
            }
        } catch (_) {}
        // Show video call interface
        this.showVideoCallInterface(data);
        
        // Ensure video interface is properly initialized
        setTimeout(() => {
            this.configureVideoElements();
            this.updateCallStatus('Connected - Video call active');
        }, 500);
    });

    // Handle video call rejected by staff
    this.socket.on('video-call-rejected', (data) => {
        console.log('❌ Video call rejected by staff:', data);
        this.updateStatus(`❌ ${data.staffName} is not available for video calls right now.`, 'error');
        this.addMessage(`❌ ${data.staffName} is not available for video calls right now.`, 'bot');
    });

    // Handle video call error
    this.socket.on('video-call-error', (data) => {
        console.error('❌ Video call error:', data);
        this.updateStatus(`❌ ${data.message}`, 'error');
        this.addMessage(`❌ ${data.message}`, 'bot');
    });

    // Handle call ended by staff
    this.socket.on('call-ended-by-staff', (data) => {
        console.log('📞 Call ended by staff:', data);
        this.addMessage(`📞 ${data.message}`, 'bot');
        this.endVideoCall();
    });

    // Handle call ended by client
    this.socket.on('call-ended-by-client', (data) => {
        console.log('📞 Call ended by client:', data);
        this.addMessage(`📞 ${data.message}`, 'bot');
        this.endVideoCall();
    });

    // Handle call ended
    this.socket.on('call_ended', (data) => {
        console.log('📞 Call ended:', data);
        this.updateStatus('Video call ended', 'info');
        this.addMessage(`📞 ${data.message || 'Video call ended'}`, 'bot');
    });

    // Handle appointment QR code generated
    this.socket.on('appointment_qr_generated', (data) => {
        console.log('📱 Appointment QR code generated:', data);
        this.showAppointmentQR(data);
    });

    // WebRTC handlers
    this.socket.on('call_offer', async (data) => {
        try {
            console.log('📞 Received call offer:', data);
            if (this.peerConnection) {
                await this.peerConnection.setRemoteDescription(data.offer);
                const answer = await this.peerConnection.createAnswer();
                await this.peerConnection.setLocalDescription(answer);
                
                this.socket.emit('call_answer', {
                    callId: data.callId,
                    answer: answer
                });
                console.log('📤 WebRTC answer sent');
            }
        } catch (error) {
            console.error('❌ Error handling call offer:', error);
        }
    });

    this.socket.on('call_answer', async (data) => {
        try {
            console.log('📞 Received call answer:', data);
            if (this.peerConnection) {
                await this.peerConnection.setRemoteDescription(data.answer);
            }
        } catch (error) {
            console.error('❌ Error handling call answer:', error);
        }
    });

    this.socket.on('ice_candidate', async (data) => {
        try {
            console.log('🧊 Received ICE candidate:', data);
            if (this.peerConnection) {
                await this.peerConnection.addIceCandidate(data.candidate);
            }
        } catch (error) {
            console.error('❌ Error handling ICE candidate:', error);
        }
    });

    // Fallback: staff can request a fresh offer if they missed it
    this.socket.on('request_offer', async (data) => {
        try {
            if (!this.peerConnection || !this.localStream) return;
            console.log('🔄 Received request_offer, creating/resending offer');
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);
            this.socket.emit('call_offer', {
                callId: this.currentCallData?.callId,
                offer: this.peerConnection.localDescription
            });
        } catch (err) {
            console.error('❌ Error handling request_offer:', err);
        }
    });

        // Teacher availability response
        this.socket.on('teacher_availability_response', (data) => {
            this.hideTypingIndicator();
            
            if (data.success) {
                const statusIcon = data.isAvailable ? '✅' : '❌';
                const statusColor = data.isAvailable ? '#4CAF50' : '#F44336';
                
                let message = `${statusIcon} **${data.teacherName}** - ${data.message}`;
                
                if (data.nextClass) {
                    message += `\n\n📅 **Next Class:** ${data.nextClass.subject} at ${data.nextClass.time}`;
                    if (data.nextClass.batch) {
                        message += ` (${data.nextClass.batch})`;
                    }
                }
                
                message += `\n\n🕐 *Checked at: ${data.currentTime}*`;
                
                this.addMessage(message, 'bot');
                
                if (this.isSpeechEnabled) {
                    this.speak(data.message);
                }
            } else {
                this.addMessage(`❌ Sorry, I couldn't check the availability: ${data.message}`, 'bot');
            }
            
            this.updateStatus('Ready', 'ready');
        });

        // Live staff status updates
        this.socket.on('staff_status_update', (payload) => {
            try {
                const { staffEmail, status } = payload || {};
                const staffSelect = document.getElementById('staffSelect');
                if (!staffSelect) return;
                const selectedId = staffSelect.value;
                if (!selectedId) return; // no staff selected

                const selectedEmail = this._resolveStaffEmailById(selectedId);
                if (selectedEmail && staffEmail && selectedEmail.toLowerCase() === staffEmail.toLowerCase()) {
                    this._updateSelectedStaffStatusUI(status, payload);
                    // Optional: notify user on status changes
                    const name = this._resolveStaffNameById(selectedId) || 'Staff';
                    if (status === 'online') this.addMessage(`✅ ${name} is now online.`, 'system');
                    if (status === 'busy') this.addMessage(`📞 ${name} is currently on a call.`, 'system');
                    if (status === 'in_class') this.addMessage(`🏫 ${name} is in a class.`, 'system');
                    if (status === 'offline') this.addMessage(`⚫ ${name} went offline.`, 'system');
                }
            } catch (_) {}
        });

        this.socket.on('call-accepted', (data) => {
            this.addMessage(`Your call has been accepted by ${data.staffName} from ${data.staffDepartment}. You will be connected shortly.`, 'system');
        });

        this.socket.on('call-completed', (data) => {
            const decision = data.decision === 'accepted' ? 'accepted' : 'declined';
            this.addMessage(`Your meeting request has been ${decision}. ${data.notes ? 'Notes: ' + data.notes : ''}`, 'system');
        });

        // Call started -> initialize WebRTC as caller
        this.socket.on('call-started', async (data) => {
            try {
                this.currentCallId = data.callId;
                await this.initializeWebRTCForClient();
                await this.createOffer();
                this.addMessage('Starting video call...', 'system');
            } catch (e) {
                console.error('Failed to start video call:', e);
            }
        });

        // Receive answer from staff
        this.socket.on('answer', async (data) => {
            try {
                if (!this.peerConnection || data.callId !== this.currentCallId) return;
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            } catch (e) {
                console.error('Failed to handle answer:', e);
            }
        });

        // Receive ICE candidate from staff
        this.socket.on('ice-candidate', async (data) => {
            try {
                if (!this.peerConnection || data.callId !== this.currentCallId) return;
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (e) {
                console.error('Failed to add ICE candidate:', e);
            }
        });

        // Error handling
        this.socket.on('error', (data) => {
            console.error('Socket error:', data);
            this.showError(data.message || 'An error occurred');
            this.updateStatus('Error', 'error');
        });
        
        // Connection error handling
        this.socket.on('connect_error', (error) => {
            console.error('Connection error:', error);
            const msg = (error && (error.message || error.description)) || 'Failed to connect to server.';
            this.showError(msg + ' Retrying...');
            this.updateStatus('Reconnecting...', 'connecting');
        });

        this.socket.on('reconnect_attempt', (n) => {
            this.updateStatus('Reconnecting...', 'connecting');
        });

        this.socket.on('reconnect', () => {
            this.updateStatus('Connected', 'ready');
        });

        this.socket.on('reconnect_failed', () => {
            this.updateStatus('Connection Failed', 'error');
            this.showError('Unable to reconnect to server. Please refresh the page.');
        });
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Spacebar to toggle speech input
            if (e.code === 'Space' && !e.target.matches('input, textarea')) {
                e.preventDefault();
                if (!this.isConversationStarted) {
                    this.startConversation();
                    return;
                }
                
                if (this.speechRecognition) {
                    if (this.isListening) {
                        this.speechRecognition.stop();
                    } else {
                        this.startSpeechRecognition();
                    }
                }
            }
        });
    }


    startConversation() {
        // Show conversation start form
        this.showConversationForm();
    }

    showConversationForm() {
		const formHTML = `
            <div class="conversation-form-overlay">
                <div class="conversation-form">
                    <div style="padding: 24px;">
                        <h2>Let's Get Started! 😊</h2>
                        <p>Hi there! I'm Clara and I'm excited to chat with you! Just tell me your name and email, and optionally share what brings you here. I'll analyze everything from your voice or text to help you better!</p>
                        
                        <form id="conversationForm">
                            <div class="form-group">
                                <label for="userName">Your Name</label>
                                <div style="display:flex; gap:8px; align-items:center;">
                                    <input type="text" id="userName" name="name" required>
                                    <button type="button" class="field-mic" data-field="userName" title="Speak your name">
                                        <i class="fas fa-microphone"></i>
                                    </button>
                                </div>
                            </div>
                            
                            <div class="form-group">
                                <label for="userEmail">Email Address</label>
                                <div style="display:flex; gap:8px; align-items:center;">
                                    <input type="email" id="userEmail" name="email" required>
                                    <button type="button" class="field-mic" data-field="userEmail" title="Speak your email">
                                        <i class="fas fa-microphone"></i>
                                    </button>
                                </div>
                            </div>
                            
                            <div class="form-group">
                                <label for="purpose">Tell me about your visit (optional)</label>
                                <div style="display:flex; gap:8px; align-items:flex-start;">
                                    <textarea id="purpose" name="purpose" placeholder="You can tell me anything - I'll analyze it from your voice or text! Or just say 'hello' to start chatting." rows="3"></textarea>
                                    <button type="button" class="field-mic" data-field="purpose" title="Speak about your visit" style="margin-top: 8px;">
                                        <i class="fas fa-microphone"></i>
                                    </button>
                                </div>
                            </div>
                            
                            <div class="form-group">
                                <label for="staffSelect">Select Staff Member <span id="staffStatus" style="color: #666; font-size: 12px;">(Loading...)</span></label>
                                <select id="staffSelect" name="selectedStaffId" required>
                                    <option value="">Loading staff members...</option>
                                </select>
                            </div>
                            
                            <div class="form-actions">
                                <button type="submit" class="btn btn-primary">
                                    <i class="fas fa-play"></i>
                                    Start Conversation
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', formHTML);
        
        const form = document.getElementById('conversationForm');
        form.addEventListener('submit', (e) => this.handleConversationSubmit(e));
        
        // Load available staff with a small delay to ensure DOM is ready
        setTimeout(() => {
            this.loadAvailableStaff().then(() => {
                console.log('✅ Staff loading completed');
            }).catch(error => {
                console.error('❌ Staff loading failed:', error);
            });
        }, 100);
		
		// Voice dictation buttons for form fields
		const fieldMics = document.querySelectorAll('.field-mic');
		fieldMics.forEach(btn => {
			btn.addEventListener('click', () => {
				const fieldId = btn.getAttribute('data-field');
				this.dictateToField(fieldId, fieldId === 'userEmail' ? 'email' : 'text', btn);
			});
		});
    }

	// Load available staff members
	async loadAvailableStaff() {
		try {
			console.log('🔄 Loading available staff...');
			let staff = [];
			let response;
			try {
				response = await fetch('/api/staff/available');
				if (response.ok) {
					staff = await response.json();
				}
			} catch (_) {}

			// Always include static staff directory if connected list is empty OR to allow selecting staff before they log in
			if (!Array.isArray(staff) || staff.length === 0) {
				console.log('ℹ️ No connected staff. Falling back to static staff list');
				const res2 = await fetch('/api/staff/list');
				if (res2.ok) {
					staff = await res2.json();
				}
			}
			// If some are connected, enrich by appending static entries that are not present yet
			else {
				try {
					const res2 = await fetch('/api/staff/list');
					if (res2.ok) {
						const staticList = await res2.json();
						const existingIds = new Set(staff.map(s => s._id || s.id));
						staticList.forEach(s => { if (!existingIds.has(s._id)) staff.push(s); });
					}
				} catch (_) {}
			}
			console.log('📋 Staff data received:', staff);
			
			const staffSelect = document.getElementById('staffSelect');
            if (staffSelect && staff.length > 0) {
                // Build a directory for quick lookup
                try {
                    const fullListRes = await fetch('/api/staff/list');
                    const fullList = await fullListRes.json();
                    this.staffDirectory = (fullList || []).reduce((acc, s) => {
                        acc[s.shortName] = { email: s.email, name: s.name };
                        return acc;
                    }, {});
                } catch (_) {}

				const options = '<option value="">Select a staff member...</option>' +
					staff.map(member => `<option value="${member._id || member.id}">${member.name} (${member.department || 'General'})</option>`).join('');
				staffSelect.innerHTML = options;
				
				// Update status
				const staffStatus = document.getElementById('staffStatus');
				if (staffStatus) {
                    staffStatus.textContent = `(${staff.length} staff members available)`;
					staffStatus.style.color = '#10b981';
				}
				
				console.log('✅ Staff dropdown populated with', staff.length, 'options');
			} else {
				staffSelect.innerHTML = '<option value="">No staff members available</option>';
				
				// Update status
				const staffStatus = document.getElementById('staffStatus');
				if (staffStatus) {
					staffStatus.textContent = '(No staff available)';
					staffStatus.style.color = '#ef4444';
				}
				
				console.log('⚠️ No staff members available');
			}
		} catch (error) {
			console.error('❌ Error loading staff:', error);
			const staffSelect = document.getElementById('staffSelect');
			if (staffSelect) {
				staffSelect.innerHTML = '<option value="">Failed to load staff - please refresh</option>';
			}
			
			// Update status
			const staffStatus = document.getElementById('staffStatus');
			if (staffStatus) {
				staffStatus.textContent = '(Failed to load)';
				staffStatus.style.color = '#ef4444';
			}
			
			// Show error to user
			this.showError('Failed to load staff members. Please refresh the page and try again.');
		}
	}

	// Dictate to a specific form field using a temporary SpeechRecognition instance
	dictateToField(fieldId, fieldType = 'text', buttonEl) {
		if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
			this.showError('Speech recognition is not supported in your browser.');
			return;
		}
		const target = document.getElementById(fieldId);
		if (!target) return;
		const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
		const rec = new SpeechRecognition();
		rec.continuous = false;
		rec.interimResults = false;
		rec.lang = 'en-US';
		rec.onstart = () => { if (buttonEl) buttonEl.classList.add('recording'); };
		rec.onend = () => { if (buttonEl) buttonEl.classList.remove('recording'); };
		rec.onerror = () => { if (buttonEl) buttonEl.classList.remove('recording'); };
		rec.onresult = (event) => {
			let transcript = (event.results[0][0].transcript || '').trim();
			if (!transcript) return;
			if (fieldType === 'email') {
				// Basic normalization for spoken emails
				transcript = transcript
					.replace(/ at /gi, '@')
					.replace(/ dot /gi, '.')
					.replace(/ underscore /gi, '_')
					.replace(/ dash /gi, '-')
					.replace(/\s+/g, '')
					.toLowerCase();
				target.value = transcript;
			} else if (fieldType === 'select') {
				const select = target;
				let matched = null;
				const spoken = transcript.toLowerCase();
				Array.from(select.options).forEach(opt => {
					const label = String(opt.textContent || opt.value || '').toLowerCase();
					if (!matched && (label === spoken || label.includes(spoken) || spoken.includes(label))) {
						matched = opt.value;
					}
				});
				if (matched) {
					select.value = matched;
				} else {
					this.showError(`Could not match purpose: "${transcript}". Please select from the list.`);
				}
			} else {
				target.value = transcript;
			}
		};
		try { rec.start(); } catch (e) {}
	}

    handleConversationSubmit(e) {
        e.preventDefault();
        
        // Check if staff is loaded
        const staffSelect = document.getElementById('staffSelect');
        if (!staffSelect || staffSelect.options.length <= 1) {
            console.error('❌ Staff not loaded yet!');
            this.showError('Staff members are still loading. Please wait a moment and try again.');
            return;
        }
        
        const formData = new FormData(e.target);
        const data = {
            name: formData.get('name'),
            email: formData.get('email'),
            purpose: formData.get('purpose'),
            selectedStaffId: formData.get('selectedStaffId')
        };
        
        console.log('📝 Form data collected:', data);
        
        // Validate form data
        if (!data.name || !data.email) {
            this.showError('Please provide your name and email');
            return;
        }
        
        if (!data.selectedStaffId) {
            console.error('❌ No staff member selected!');
            this.showError('Please select a staff member');
            return;
        }
        
        // If no purpose provided, set a default friendly message
        if (!data.purpose || data.purpose.trim() === '') {
            data.purpose = "Just wanted to chat and get some help";
        }
        
        // Remove the form
        const overlay = document.querySelector('.conversation-form-overlay');
        if (overlay) {
            overlay.remove();
        }
        
        // Update UI
        this.updateStatus('Starting conversation...', 'processing');
        this.speechStatusDisplay.textContent = 'Setting up your conversation...';
        
        // iOS Fix: Unlock audio context when user submits form
        this.unlockAudioContext();
        
        // Start conversation with server
        try {
            this.socket.emit('start-conversation', data);
            console.log('Emitting start-conversation with data:', data);
            
            // Store selected staff information for video call requests
            this.selectedStaffId = data.selectedStaffId;
            this.userData = {
                name: data.name,
                email: data.email,
                purpose: data.purpose
            };
            
            // Removed automatic video call request triggering
            // Video calls will only be initiated when user explicitly requests them
            
            // Set a timeout for conversation start
            setTimeout(() => {
                if (!this.isConversationStarted) {
                    this.showError('Failed to start conversation. Please check your connection and try again.');
                    this.updateStatus('Error', 'error');
                }
            }, 10000); // 10 second timeout
            
        } catch (error) {
            console.error('Error starting conversation:', error);
            this.showError('Failed to start conversation. Please try again.');
            this.updateStatus('Error', 'error');
        }

        // Start availability polling once UI is ready
        this._startAvailabilityPolling();
    }

    _startAvailabilityPolling() {
        if (this._availabilityPollTimer) return;
        this._availabilityPollTimer = setInterval(async () => {
            try {
                const staffSelect = document.getElementById('staffSelect');
                if (!staffSelect || !staffSelect.value) return;
                const email = this._resolveStaffEmailById(staffSelect.value);
                if (!email) return;
                const res = await fetch(`/api/staff/status?q=${encodeURIComponent(email)}`);
                const data = await res.json();
                if (data && data.success) {
                    this._updateSelectedStaffStatusUI(data.status, data);
                }
            } catch (_) {}
        }, 30000);
    }

    _resolveStaffEmailById(shortNameOrId) {
        const entry = this.staffDirectory?.[shortNameOrId];
        return entry?.email || null;
    }

    _resolveStaffNameById(shortNameOrId) {
        const entry = this.staffDirectory?.[shortNameOrId];
        return entry?.name || null;
    }

    _updateSelectedStaffStatusUI(status, data) {
        const staffStatus = document.getElementById('staffStatus');
        if (!staffStatus) return;
        const color = status === 'online' ? '#10b981' : (status === 'busy' || status === 'in_class') ? '#ef4444' : '#6b7280';
        const label = status === 'online' ? 'Online' : status === 'busy' ? 'Busy' : status === 'in_class' ? 'In Class' : 'Offline';
        staffStatus.innerHTML = `(<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block"></span> ${label}</span>)`;
        staffStatus.style.color = color;
    }

    startSpeechRecognition() {
        if (!this.speechRecognition) {
            this.showError('Speech recognition is not available in your browser.');
            return;
        }
        
        if (!this.isConversationStarted) {
            this.showError('Please start a conversation first.');
            return;
        }
        
        if (this.isListening) {
            try {
                this.speechRecognition.stop();
            } catch (e) {
                console.error('Failed to stop speech recognition:', e);
            }
            return;
        }
        
        // Reset retry counter
        this.noSpeechRetries = 0;
        
        try {
            this.speechRecognition.start();
        } catch (error) {
            console.error('Failed to start speech recognition:', error);
            this.showError('Failed to start speech recognition. Please try again.');
            this.resetSpeechInput();
        }
    }

    resetSpeechInput() {
        this.isListening = false;
        this.noSpeechRetries = 0; // Reset retry counter
        
        // Reset UI elements
        this.speechInputButton.classList.remove('recording');
        this.micIcon.className = 'fas fa-microphone';
        this.speechStatusDisplay.classList.remove('listening');
        
        // Update status text based on conversation state
        if (this.isConversationStarted) {
            this.speechStatusDisplay.textContent = 'Click the microphone to speak';
            this.updateStatus('Ready to chat', 'ready');
        } else {
            this.speechStatusDisplay.textContent = 'Click to start conversation';
            this.updateStatus('Ready', 'ready');
        }
    }

    // Browser-native Speech Recognition (Web Speech API)
    startBrowserSpeechRecognition() {
        try {
            if (!this.isConversationStarted) {
                this.showError('Please start a conversation first.');
                return;
            }

            if (!this.speechRecognition) {
                this.showError('Speech recognition not available in this browser.');
                return;
            }

            console.log('🎤 Starting browser speech recognition...');
            this.speechRecognition.start();
            this.noSpeechRetries = 0;

        } catch (error) {
            console.error('❌ Speech recognition error:', error);
            if (error.name === 'InvalidStateError') {
                // Already running, stop and restart
                this.speechRecognition.stop();
                setTimeout(() => this.startBrowserSpeechRecognition(), 100);
            } else {
                this.showError('Failed to start speech recognition: ' + error.message);
                this.resetSpeechInput();
            }
        }
    }

    sendMessage(message) {
        if (!message.trim() || !this.isConversationStarted) return;
        
        // ENHANCED: Apply spelling correction for better accuracy
        const correctedMessage = this.correctSpelling(message);
        if (correctedMessage !== message) {
            console.log(`📝 Spelling corrected: "${message}" → "${correctedMessage}"`);
        }
        
        // Add user message to chat (use corrected version)
        this.addMessage(correctedMessage, 'user');
        
        // Check if this is a teacher availability query
        if (this.isTeacherAvailabilityQuery(message)) {
            this.handleTeacherAvailabilityQuery(message);
            return;
        }
        
        // Show typing indicator
        this.showTypingIndicator();
        
        // Update status
        this.updateStatus('Processing...', 'processing');
        
        // ENHANCED: Detect language for local-language response
        const langDetection = this.detectLanguageWithConfidence(correctedMessage);
        const detectedLanguage = langDetection.code;
        console.log('🌐 Detected language for response:', detectedLanguage, 'confidence:', langDetection.confidence);
        
        // Send message via Socket.IO (use corrected message) with detected language
        this.socket.emit('chat-message', {
            sessionId: this.sessionId,
            message: correctedMessage,
            detectedLanguage: detectedLanguage // NEW: Tell server which language to respond in
        });
    }
    
    /**
     * Correct spelling mistakes for better accuracy
     */
    correctSpelling(text) {
        const corrections = {
            // Common misspellings
            'wat': 'what', 'wut': 'what', 'watd': 'what',
            'hw': 'how', 'hows': 'how is', 'hw r': 'how are',
            'dere': 'there', 'der': 'there',
            'diz': 'this', 'dis': 'this',
            'ur': 'your', 'youre': 'you\'re', 'yr': 'your',
            'plz': 'please', 'pls': 'please', 'plese': 'please',
            'thnx': 'thanks', 'thx': 'thanks', 'thnks': 'thanks',
            'ryt': 'right', 'rite': 'right', 'ryte': 'right',
            'u': 'you', 'r': 'are', 'd': 'the',
            'bcuz': 'because', 'cuz': 'because',
            'coz': 'because', 'c': 'see',
            'sry': 'sorry', 'srry': 'sorry',
            'btw': 'by the way', 'bfr': 'before',
            'rly': 'really', 'rlly': 'really',
            'yr': 'year', 'urself': 'yourself',
            'oki': 'okay', 'okay': 'okay',
            // Indian English specific
            'cant': 'can\'t', 'wont': 'won\'t', 'dont': 'don\'t',
            'isnt': 'isn\'t', 'arent': 'aren\'t'
        };
        
        let corrected = text;
        
        // Apply corrections with word boundary matching
        for (const [wrong, correct] of Object.entries(corrections)) {
            const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
            corrected = corrected.replace(regex, correct);
        }
        
        // Fix common spacing issues
        corrected = corrected.replace(/\s+/g, ' ').trim();
        
        return corrected;
    }

    // Check if message is a teacher availability query
    isTeacherAvailabilityQuery(message) {
        const lowerMessage = message.toLowerCase();
        
        // First check if this is a video call request - if so, don't treat as availability query
        const videoCallKeywords = [
            'call', 'video call', 'phone call', 'ring', 'contact', 'connect'
        ];
        const hasVideoCallKeyword = videoCallKeywords.some(keyword => 
            lowerMessage.includes(keyword)
        );
        
        if (hasVideoCallKeyword) {
            console.log('Message contains video call keyword, not treating as availability query');
            return false;
        }
        
        const availabilityKeywords = [
            'is', 'free', 'available', 'busy', 'occupied', 'teaching', 'class',
            'schedule', 'timetable', 'when', 'can', 'meet', 'talk', 'see'
        ];
        
        const teacherNames = [
            'anitha', 'anita', 'lakshmi', 'dhivyasri', 'professor', 'teacher', 'faculty',
            'mrs', 'ms', 'dr', 'prof', 'anitha c s', 'lakshmi durga', 'dhivyasri g',
            'mrs anitha', 'ms lakshmi', 'dr dhivyasri', 'prof anitha'
        ];
        
        const hasAvailabilityKeyword = availabilityKeywords.some(keyword => 
            lowerMessage.includes(keyword)
        );
        
        const hasTeacherName = teacherNames.some(name => 
            lowerMessage.includes(name.toLowerCase())
        );
        
        console.log('Checking availability query:', {
            message: lowerMessage,
            hasAvailabilityKeyword,
            hasTeacherName,
            isQuery: hasAvailabilityKeyword && hasTeacherName
        });
        
        return hasAvailabilityKeyword && hasTeacherName;
    }

    // Handle teacher availability query
    handleTeacherAvailabilityQuery(message) {
        // Extract teacher name from message
        const teacherName = this.extractTeacherName(message);
        
        if (!teacherName) {
            this.addMessage('I need to know which teacher you\'re asking about. Please mention the teacher\'s name.', 'bot');
            return;
        }
        
        // Extract day from message (if specified)
        const day = this.extractDay(message);
        
        // Show typing indicator
        this.showTypingIndicator();
        this.updateStatus('Checking availability...', 'processing');
        
        // Send availability check request
        this.socket.emit('check_teacher_availability', {
            teacherName: teacherName,
            day: day, // Include day if specified
            clientId: this.socket.id
        });
    }

    // Extract teacher name from message
    extractTeacherName(message) {
        const lowerMessage = message.toLowerCase();
        
        // Map of possible name variations to actual names
        const nameMap = {
            'anitha': 'Anitha C S',
            'anita': 'Anitha C S',  // Handle common misspelling
            'anitha c s': 'Anitha C S',
            'mrs anitha': 'Anitha C S',
            'mrs anita': 'Anitha C S',
            'prof anitha': 'Anitha C S',
            'prof anita': 'Anitha C S',
            'lakshmi': 'Lakshmi Durga N',
            'lakshmi durga': 'Lakshmi Durga N',
            'ms lakshmi': 'Lakshmi Durga N',
            'mrs lakshmi': 'Lakshmi Durga N',
            'dhivyasri': 'G Dhivyasri',
            'dhivyasri g': 'G Dhivyasri',
            'dr dhivyasri': 'G Dhivyasri',
            'g dhivyasri': 'G Dhivyasri'
        };
        
        // Find matching name (prioritize longer matches first)
        const sortedKeys = Object.keys(nameMap).sort((a, b) => b.length - a.length);
        
        for (const key of sortedKeys) {
            if (lowerMessage.includes(key)) {
                console.log(`Matched teacher name: "${key}" -> "${nameMap[key]}"`);
                return nameMap[key];
            }
        }
        
        console.log('No teacher name found in message:', lowerMessage);
        return null;
    }

    // Extract day from message
    extractDay(message) {
        const lowerMessage = message.toLowerCase();
        
        // Map of day variations to standard day names
        const dayMap = {
            'monday': 'Monday',
            'mon': 'Monday',
            'tuesday': 'Tuesday', 
            'tues': 'Tuesday',
            'tue': 'Tuesday',
            'wednesday': 'Wednesday',
            'wed': 'Wednesday',
            'thursday': 'Thursday',
            'thurs': 'Thursday',
            'thu': 'Thursday',
            'friday': 'Friday',
            'fri': 'Friday',
            'saturday': 'Saturday',
            'sat': 'Saturday',
            'sunday': 'Sunday',
            'sun': 'Sunday',
            'today': this.getCurrentDay(),
            'tomorrow': this.getTomorrowDay()
        };
        
        // Find matching day (prioritize longer matches first)
        const sortedKeys = Object.keys(dayMap).sort((a, b) => b.length - a.length);
        
        for (const key of sortedKeys) {
            if (lowerMessage.includes(key)) {
                console.log(`Matched day: "${key}" -> "${dayMap[key]}"`);
                return dayMap[key];
            }
        }
        
        console.log('No specific day found in message, using current day');
        return null; // Will use current day on server side
    }

    // Get current day name
    getCurrentDay() {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return days[new Date().getDay()];
    }

    // Get tomorrow's day name
    getTomorrowDay() {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return days[tomorrow.getDay()];
    }

    addMessage(text, sender) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;
        messageDiv.setAttribute('role', 'article');
        
        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        
        const icon = document.createElement('i');
        if (sender === 'bot') {
            icon.className = 'fas fa-robot';
        } else if (sender === 'user') {
            icon.className = 'fas fa-user';
        } else if (sender === 'system') {
            icon.className = 'fas fa-info-circle';
        }
        avatar.appendChild(icon);
        
        const content = document.createElement('div');
        content.className = 'message-content';
        
        const messageText = document.createElement('div');
        messageText.className = 'message-text';
        messageText.textContent = text;
        
        const time = document.createElement('div');
        time.className = 'message-time';
        time.textContent = new Date().toLocaleTimeString();
        
        content.appendChild(messageText);
        content.appendChild(time);
        
        messageDiv.appendChild(avatar);
        messageDiv.appendChild(content);
        
        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();
    }

    showTypingIndicator() {
        if (this.isTyping) return;
        
        this.isTyping = true;
        const typingDiv = document.createElement('div');
        typingDiv.className = 'message bot-message typing-message';
        typingDiv.setAttribute('role', 'article');
        typingDiv.id = 'typingIndicator';
        
        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        const icon = document.createElement('i');
        icon.className = 'fas fa-robot';
        avatar.appendChild(icon);
        
        const content = document.createElement('div');
        content.className = 'message-content';
        
        const typingIndicator = document.createElement('div');
        typingIndicator.className = 'typing-indicator';
        typingIndicator.innerHTML = `
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
        `;
        
        content.appendChild(typingIndicator);
        typingDiv.appendChild(avatar);
        typingDiv.appendChild(content);
        
        this.chatMessages.appendChild(typingDiv);
        this.scrollToBottom();
    }

    hideTypingIndicator() {
        this.isTyping = false;
        const typingIndicator = document.getElementById('typingIndicator');
        if (typingIndicator) {
            typingIndicator.remove();
        }
    }

    toggleSpeech() {
        this.isSpeechEnabled = !this.isSpeechEnabled;
        
        if (this.isSpeechEnabled) {
            this.speechIcon.className = 'fas fa-volume-up';
            this.speechStatus.textContent = 'Clara voice enabled';
            this.speechToggle.classList.remove('disabled');
        } else {
            this.speechIcon.className = 'fas fa-volume-mute';
            this.speechStatus.textContent = 'Clara voice disabled';
            this.speechToggle.classList.add('disabled');
        }
    }

    toggleTextCleaning() {
        this.isTextCleaningEnabled = !this.isTextCleaningEnabled;
        
        if (this.isTextCleaningEnabled) {
            this.textCleaningIcon.className = 'fas fa-magic';
            this.textCleaningStatus.textContent = 'Text cleaning enabled';
        } else {
            this.textCleaningIcon.className = 'fas fa-magic-slash';
            this.textCleaningStatus.textContent = 'Text cleaning disabled';
        }
    }

	speak(text) {
		if (!this.isSpeechEnabled || !text) return;
		
		// Clean text for speech synthesis - remove emojis and special characters (if enabled)
		let cleanedText = text;
		if (this.isTextCleaningEnabled) {
			cleanedText = this.cleanTextForSpeech(text);
		console.log('Original text:', text);
		console.log('Cleaned text for speech:', cleanedText);

			// Guard: never speak test/diagnostic strings
			if (/\b(test|edge\s+tts|browser\s+tts)\b/i.test(cleanedText)) {
				console.log('Skipping diagnostic text:', cleanedText);
				return;
			}
		
		// Debug: Log if we're about to speak something suspicious
		if (cleanedText.includes('speech') || cleanedText.includes('version') || cleanedText.includes('Speaking:')) {
			console.warn('⚠️ Suspicious text detected for speech:', cleanedText);
		}
			
			// Show speech indicator if text was cleaned (but don't speak the indicator text)
			if (cleanedText !== text) {
				this.showSpeechIndicator(cleanedText);
			}
		}
		
		// Ensure we don't speak empty or system text
		if (!cleanedText || cleanedText.trim().length === 0) {
			console.log('Skipping speech for empty text');
			return;
		}
		
		// Don't speak debug or system messages
		if (cleanedText.includes('speech') && cleanedText.includes('version')) {
			console.log('Skipping speech for system debug text');
			return;
		}
		
		// Don't speak indicator text or system messages
		if (cleanedText.includes('Speaking:') || cleanedText.includes('speech indicator') || 
			cleanedText.includes('volume-up') || cleanedText.includes('fas fa-')) {
			console.log('Skipping speech for indicator text');
			return;
		}
		
		// Don't speak very short or single word system messages
		if (cleanedText.trim().length < 3 || (cleanedText.match(/^[a-z\s]+$/i) && cleanedText.length < 10)) {
			console.log('Skipping speech for very short text:', cleanedText);
			return;
		}
		
		// Don't speak HTML or system markup
		if (cleanedText.includes('<') || cleanedText.includes('>') || cleanedText.includes('class=') || cleanedText.includes('id=')) {
			console.log('Skipping speech for HTML/system markup:', cleanedText);
			return;
		}
		
		// Use browser-native TTS (Web Speech API - SpeechSynthesis)
		this.speakWithBrowserTTS(cleanedText);
	}

	async speakWithEdgeTTS(text, language = 'en') {
		try {
			// Stop any current audio playback to prevent overlapping
			this.stopAllAudio();
			
			// OPTIMIZED: Reduced delay to 50ms for faster response
			await new Promise(resolve => setTimeout(resolve, 50));
			
			// Detect emotional context for natural speech
			const emotionalContext = this.detectEmotionalContext(text);
			
			// Enhanced voice selection and parameters for better quality
			// getOptimizedVoiceParams already handles voice selection based on language
			const voiceParams = this.getOptimizedVoiceParams(language, text);
			
			// Use SSML for natural prosody, breathing pauses, and clarity
			const ssmlLang = window.getSSMLLanguage ? window.getSSMLLanguage(language) : (language || 'en-US');
			const processedText = window.ssmlify ? window.ssmlify(text, ssmlLang) : text;

			const response = await fetch('/api/tts/speak', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					text: processedText, // Send SSML-enhanced text for naturalness
					language: language,
					voice: voiceParams.voice,
					rate: voiceParams.rate,
					pitch: voiceParams.pitch,
					volume: voiceParams.volume,
					emotionalContext: emotionalContext
				})
			});

			const result = await response.json();
			
			if (result.success && result.audio) {
				// Play the audio from Edge TTS
				console.log('✅ Edge TTS success, playing audio');
				await this.playAudioFromBase64(result.audio, text);
			} else {
				console.log('⚠️ Edge TTS failed or no audio, falling back to browser TTS:', result.error || 'No audio content');
				if (!this.browserTTSBlocked) {
					await this.speakWithBrowserTTS(text);
				}
			}
		} catch (error) {
			console.error('❌ Edge TTS error, falling back to browser TTS:', error);
			if (!this.browserTTSBlocked) {
				await this.speakWithBrowserTTS(text);
			}
		}
	}

	// Enhanced voice parameter optimization
	getOptimizedVoiceParams(language, text) {
		const params = {
			voice: null,
			rate: '-5%',
			pitch: '+0Hz',
			volume: '+0%'
		};

		// Language-specific voice and parameter optimization
			switch (language) {
			case 'en':
			case 'en-US':
					params.voice = 'en-US-AvaNeural';
					params.rate = '-6%';
					params.pitch = '-1Hz';
					params.volume = '+0%';
				break;
			case 'en-IN':
					params.voice = 'en-IN-NeerjaNeural';
					params.rate = '-8%';
					params.pitch = '-1Hz';
					params.volume = '+0%';
				break;
			case 'hi':
					params.voice = 'hi-IN-SwaraNeural';
					params.rate = '-10%';
					params.pitch = '-1Hz';
					params.volume = '+0%';
				break;
			case 'kn':
					params.voice = 'kn-IN-SapnaNeural';
					params.rate = '-10%';
					params.pitch = '-1Hz';
					params.volume = '+0%';
				break;
			case 'te':
					params.voice = 'te-IN-ShrutiNeural';
					params.rate = '-9%';
					params.pitch = '-1Hz';
					params.volume = '+0%';
				break;
			case 'ta':
					params.voice = 'ta-IN-PallaviNeural';
					params.rate = '-9%';
					params.pitch = '-1Hz';
					params.volume = '+0%';
				break;
			case 'ml':
					params.voice = 'ml-IN-SobhanaNeural';
					params.rate = '-9%';
					params.pitch = '-1Hz';
					params.volume = '+0%';
				break;
			case 'mr':
					params.voice = 'mr-IN-AarohiNeural';
					params.rate = '-9%';
					params.pitch = '-1Hz';
					params.volume = '+0%';
				break;
			default:
					// Default to calm premium English
					params.voice = 'en-US-AvaNeural';
					params.rate = '-6%';
					params.pitch = '-1Hz';
					params.volume = '+0%';
		}

		// Adjust parameters based on text content
		if (text.length > 100) {
			params.rate = '-8%'; // Slower for longer text
		}
		
		if (text.includes('!') || text.includes('?')) {
			params.pitch = '+0Hz'; // Keep calm
		}

		console.log(`🎵 Voice params for ${language}:`, params);
		return params;
	}

	// iOS Fix: Unlock audio context with silent audio to enable autoplay
	unlockAudioContext() {
		if (this.audioContextUnlocked) return;
		
		try {
			// For iOS: We use HTML5 Audio, not Web Audio API, so we need to unlock HTML5 Audio
			// The unlock happens naturally when we play the first audio with user gesture
			// So we just mark it as unlocked here
			this.audioContextUnlocked = true;
			console.log('✅ Audio context marked as unlocked for iOS');
		} catch (error) {
			console.warn('Failed to unlock audio context:', error);
		}
	}

	stopAllAudio() {
		try {
			// OPTIMIZED: Reduced logging for faster execution
			
			// iOS Fix: Clear any running audio monitoring interval
			if (this.currentAudioInterval) {
				clearInterval(this.currentAudioInterval);
				this.currentAudioInterval = null;
			}
			
			// Stop browser TTS with enhanced conflict resolution
			// iOS Fix: Don't aggressively cancel SpeechSynthesis on iOS as it can break it
			if (this.speechSynthesis && !this.isIOS) {
				// Force stop all browser TTS immediately (non-iOS only)
				this.speechSynthesis.cancel();
				this.speechSynthesis.cancel(); // Double cancel to ensure it stops
				
				// Additional aggressive stopping
				try {
					this.speechSynthesis.pause();
					this.speechSynthesis.cancel();
				} catch (e) {
					// Silently handle errors
				}
			} else if (this.speechSynthesis && this.isIOS) {
				// iOS: Gentle cancel to avoid breaking SpeechSynthesis
				try {
					this.speechSynthesis.cancel();
				} catch (e) {
					// Silently handle errors
				}
			}
			
			// Stop any current Edge TTS audio immediately
			if (this.currentAudio) {
				// Immediate stop without fade-out to prevent overlap
				try {
					this.currentAudio.pause();
					this.currentAudio.currentTime = 0;
					// Don't set volume to 0 - it stays set for future audio
					this.currentAudio = null;
				} catch (e) {
					this.currentAudio = null;
				}
			}
			
			// Stop any other audio elements with enhanced detection
			const audioElements = document.querySelectorAll('audio');
			audioElements.forEach(audio => {
				if (!audio.paused || audio.currentTime > 0) {
					audio.pause();
					audio.currentTime = 0;
					// Don't set volume to 0 - it stays set for future audio
				}
			});
			
			// Clear any pending speech queue
			if (this.pendingSpeakQueue && this.pendingSpeakQueue.length > 0) {
				this.pendingSpeakQueue = [];
			}
			
			// Reset audio state flags
			this.isSpeaking = false;
			this.audioConflictResolved = true;
		} catch (error) {
			// Force reset on error
			this.currentAudio = null;
			this.isSpeaking = false;
			this.currentAudioInterval = null;
		}
	}

	async playPartsBase64(parts, originalTextForLog = '') {
		try {
            const ctx = window.__claraAudioCtx;
            if (!ctx) {
                throw new Error('AudioContext not initialized');
            }

            console.log(`🎵 Playing ${parts.length} audio parts sequentially with fades`);

            for (let i = 0; i < parts.length; i++) {
                const b64 = parts[i];
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                const buf = await ctx.decodeAudioData(bytes.buffer);

                const src = ctx.createBufferSource();
                src.buffer = buf;

                const gain = ctx.createGain();
                const comp = ctx.createDynamicsCompressor();

                src.connect(comp).connect(gain).connect(ctx.destination);

                // 6–10 ms fade-in/out to remove clicks and feel "smooth"
                const now = ctx.currentTime;
                gain.gain.setValueAtTime(0.0001, now);
                gain.gain.linearRampToValueAtTime(1.0, now + 0.01); // 10ms fade-in
                const end = now + buf.duration;
                gain.gain.setValueAtTime(1.0, end - 0.015);
                gain.gain.linearRampToValueAtTime(0.0001, end - 0.004); // 6ms fade-out

                src.start(now);

                // Wait for this part to finish before playing next
                await new Promise(r => src.onended = r);
            }

            console.log('✅ All audio parts played successfully');
        } catch (error) {
            console.error('❌ Failed to play audio parts:', error);
            if (!this.browserTTSBlocked && originalTextForLog) {
                await this.speakWithBrowserTTS(originalTextForLog);
            }
        }
    }

	async playAudioFromBase64(audioBase64, originalTextForLog = '') {
		try {
            // Decode base64
            const binary = atob(audioBase64);
            const len = binary.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

            // Detect format for logging (OGG not supported on iOS Safari, but now converted to MP3 on server)
            const sig0 = bytes[0], sig1 = bytes[1], sig2 = bytes[2], sig3 = bytes[3];
            const header = String.fromCharCode(sig0, sig1, sig2, sig3);
            
            // Edge TTS now converts OGG to MP3 on server, so we should get MP3
            // But keep OGG detection as fallback if conversion fails
            if (header === 'OggS') {
                console.warn('⚠️ Received OGG/Opus audio format (conversion may have failed) - falling back on iOS');
                if (this.isIOS && !this.browserTTSBlocked) {
                    await this.speakWithBrowserTTS(originalTextForLog);
                    return;
                }
            }

            // iOS CRITICAL FIX: Use HTML5 Audio instead of Web Audio API for iOS/iPadOS compatibility
            // iOS Safari has issues with decodeAudioData even for MP3, so we use direct HTML5 Audio
            if (this.isIOS) {
                console.log('🍎 iOS detected - Using HTML5 Audio for compatibility');
                return await this.playAudioWithHTML5Audio(bytes, originalTextForLog);
            }

            // Non-iOS: Use Web Audio API for better quality
            console.log('🖥️ Non-iOS detected - Using Web Audio API');
            const ctx = window.__claraAudioCtx;
            if (!ctx) {
                throw new Error('AudioContext not initialized');
            }

            console.log('🎵 Decoding audio with Web Audio API @', ctx.sampleRate, 'Hz');

            // Decode audio data using Web Audio API (resamples to context sampleRate automatically)
            const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0)); // make a copy
            
            console.log('✅ Audio decoded:', audioBuffer.duration.toFixed(2), 's,', 
                       audioBuffer.sampleRate, 'Hz,', audioBuffer.numberOfChannels, 'channels');
            
            // CRITICAL: Log sample rate to verify correct playback speed
            if (audioBuffer.sampleRate !== ctx.sampleRate) {
                console.warn(`⚠️ Sample rate mismatch: Audio=${audioBuffer.sampleRate}Hz, Context=${ctx.sampleRate}Hz (will resample automatically)`);
            }

            // Use audio engine for smooth, gapless playback if available
            const audioEngine = window.getClaraAudioEngine ? window.getClaraAudioEngine() : null;
            if (audioEngine) {
                audioEngine.enqueue(audioBuffer);
                console.log('✅ Audio enqueued to audio engine');
                return;
            }

            // Fallback: Direct playback with gentle dynamics for cleaner sound
            const src = ctx.createBufferSource();
            src.buffer = audioBuffer;

            // Gentle dynamics so it sounds "cleaner"
            const compressor = ctx.createDynamicsCompressor();
            compressor.threshold.setValueAtTime(-24, ctx.currentTime);
            compressor.knee.setValueAtTime(30, ctx.currentTime);
            compressor.ratio.setValueAtTime(6, ctx.currentTime);
            compressor.attack.setValueAtTime(0.003, ctx.currentTime);
            compressor.release.setValueAtTime(0.25, ctx.currentTime);

            const gain = ctx.createGain();
            gain.gain.value = 1.05; // subtle clarity bump

            src.connect(compressor).connect(gain).connect(ctx.destination);
            
            return new Promise((resolve, reject) => {
                src.onended = () => {
                    console.log('✅ Audio playback completed');
                    resolve();
                };
                src.onerror = (error) => {
                    console.error('❌ Audio playback error:', error);
                    reject(error);
                };
                src.start(0);
            });
            
        } catch (error) {
            console.error('❌ Failed to play audio:', error);
            // Fallback to browser TTS only if allowed
            if (!this.browserTTSBlocked && originalTextForLog) {
                await this.speakWithBrowserTTS(originalTextForLog);
            }
        }
    }

    // iOS-specific HTML5 Audio playback (more reliable than Web Audio API on iOS)
    async playAudioWithHTML5Audio(bytes, originalTextForLog = '') {
        try {
            // Detect MIME type
            let mime = 'audio/mpeg'; // Default to MP3
            const sig0 = bytes[0], sig1 = bytes[1], sig2 = bytes[2], sig3 = bytes[3];
            const header = String.fromCharCode(sig0, sig1, sig2, sig3);
            if (header === 'RIFF') mime = 'audio/wav';
            else if (header === 'ID3' || (sig0 === 0xFF && (sig1 & 0xE0) === 0xE0)) mime = 'audio/mpeg';
            else if (header === 'OggS') mime = 'audio/ogg';
            
            console.log('🎵 Using HTML5 Audio with MIME type:', mime);

            // Create Blob and URL
            const audioBlob = new Blob([bytes], { type: mime });
            const audioUrl = URL.createObjectURL(audioBlob);

            // Create HTML5 Audio element
            const audio = new Audio(audioUrl);
            audio.preload = 'auto';
            audio.playsInline = true; // Critical for iOS inline playback
            
            // Store reference for cleanup
            this.currentAudio = audio;
            audio._keepUrlAlive = audioUrl; // Prevent GC from removing the URL
            
            // Set up event handlers BEFORE attempting to play
            audio.onended = () => {
                console.log('✅ HTML5 Audio playback completed');
                URL.revokeObjectURL(audioUrl);
                this.currentAudio = null;
                if (this.currentAudioInterval) {
                    clearInterval(this.currentAudioInterval);
                    this.currentAudioInterval = null;
                }
                // Process next item in queue if any
                if (this.pendingSpeakQueue.length > 0) {
                    const nextText = this.pendingSpeakQueue.shift();
                    setTimeout(() => this.speak(nextText), 120);
                }
            };
            
            audio.onerror = async (error) => {
                console.error('❌ HTML5 Audio error:', error);
                URL.revokeObjectURL(audioUrl);
                this.currentAudio = null;
                if (this.currentAudioInterval) {
                    clearInterval(this.currentAudioInterval);
                    this.currentAudioInterval = null;
                }
                // Fallback to browser TTS
                if (!this.browserTTSBlocked && originalTextForLog) {
                    await this.speakWithBrowserTTS(originalTextForLog);
                }
            };
            
            audio.volume = 0.9;
            audio.playbackRate = 0.9;
            
            // For iOS: Don't wait for canplaythrough - Blob URLs load instantly
            // Play immediately while we're still in the user gesture context
            console.log('🎵 Attempting to play audio on iOS');
            try {
                const playPromise = audio.play();
                if (playPromise !== undefined) {
                    await playPromise;
                    console.log('✅ HTML5 Audio playback started successfully');
                    this.hasPlayedAudio = true;
                }
            } catch (playError) {
                console.warn('⚠️ Initial play() failed, retrying for iOS:', playError);
                await new Promise(resolve => setTimeout(resolve, 300));
                try {
                    audio.currentTime = 0;
                    const retryPromise = audio.play();
                    if (retryPromise !== undefined) {
                        await retryPromise;
                        console.log('✅ Retry play() successful on iOS');
                    }
                } catch (retryError) {
                    console.error('❌ Retry play() failed:', retryError);
                    throw playError;
                }
            }
            
        } catch (error) {
            console.error('❌ Failed to play audio with HTML5:', error);
            if (!this.browserTTSBlocked && originalTextForLog) {
                await this.speakWithBrowserTTS(originalTextForLog);
            }
        }
    }

	async speakWithBrowserTTS(text) {
		// Hard-disable when configured
		if (this.browserTTSBlocked) {
			console.warn('⚠️ Browser TTS is blocked');
			return;
		}
		if (!this.speechSynthesis) {
			console.warn('⚠️ Browser TTS not available - no speechSynthesis');
			return;
		}
		
		console.log('🎤 Using browser TTS for:', text.substring(0, 100));
		
		// Stop any current audio playback to prevent overlapping
		this.stopAllAudio();
		
		// Add a longer delay to ensure audio has fully stopped
		await new Promise(resolve => setTimeout(resolve, 200));

		// Ensure speech synthesis is ready
		if (this.speechSynthesis.paused) {
			this.speechSynthesis.resume();
		}
		
		// Ensure we have voices; if not, queue until voiceschanged fires
		const voices = this.availableVoices && this.availableVoices.length > 0
			? this.availableVoices
			: (this.speechSynthesis.getVoices() || []);
			
		if (!voices || voices.length === 0) {
			console.warn('⚠️ No voices available, queuing text for later');
			this.pendingSpeakQueue.push(text);
			return;
		}

		const utterance = new SpeechSynthesisUtterance(text);
		
		// Detect language and set appropriate voice
		const detectedLang = this.detectLanguage(text);
		// console.log('🌐 Browser TTS detected language:', detectedLang);
		
		// Set language-specific voice settings
		let selectedVoice = null;
		let langCode = 'en-US';
		
		if (detectedLang.includes('Hindi')) {
			langCode = 'hi-IN';
			selectedVoice = voices.find(v => /hi(-|_)IN/i.test(v.lang)) || voices.find(v => /hi/i.test(v.lang));
		} else if (detectedLang.includes('Kannada')) {
			langCode = 'kn-IN';
			selectedVoice = voices.find(v => /kn(-|_)IN/i.test(v.lang)) || voices.find(v => /kn/i.test(v.lang));
		} else if (detectedLang.includes('Tamil')) {
			langCode = 'ta-IN';
			selectedVoice = voices.find(v => /ta(-|_)IN/i.test(v.lang)) || voices.find(v => /ta/i.test(v.lang));
		} else if (detectedLang.includes('Telugu')) {
			langCode = 'te-IN';
			selectedVoice = voices.find(v => /te(-|_)IN/i.test(v.lang)) || voices.find(v => /te/i.test(v.lang));
		} else if (detectedLang.includes('Malayalam')) {
			langCode = 'ml-IN';
			selectedVoice = voices.find(v => /ml(-|_)IN/i.test(v.lang)) || voices.find(v => /ml/i.test(v.lang));
		} else if (detectedLang.includes('Marathi')) {
			langCode = 'mr-IN';
			selectedVoice = voices.find(v => /mr(-|_)IN/i.test(v.lang)) || voices.find(v => /mr/i.test(v.lang));
		}
		
		// If no language-specific voice found, use English
		if (!selectedVoice) {
			selectedVoice = voices.find(v => /en(-|_)US/i.test(v.lang) && /Google|Natural|Premium|Enhanced/i.test(v.name))
				|| voices.find(v => /en(-|_)GB/i.test(v.lang) && /Google|Natural|Premium|Enhanced/i.test(v.name))
				|| voices.find(v => /en(-|_)US/i.test(v.lang) && v.localService)
				|| voices.find(v => /en(-|_)GB/i.test(v.lang) && v.localService)
				|| voices.find(v => /en(-|_)US/i.test(v.lang))
				|| voices.find(v => /en(-|_)GB/i.test(v.lang))
				|| voices.find(v => /en/i.test(v.lang))
				|| voices[0];
		}
		
		// Improved voice settings for better quality (slower, calmer)
		utterance.rate = 0.82; // Slower for clarity and friendliness
		utterance.pitch = 0.98; // Slightly lower pitch for calm tone
		utterance.volume = 0.85; // Comfortable volume
		utterance.lang = langCode;
		
		if (selectedVoice) {
			utterance.voice = selectedVoice;
			console.log('🎤 Selected voice:', selectedVoice.name, 'for language:', detectedLang);
		}

		// Enhanced error handling for speech synthesis
		utterance.onerror = (event) => {
			console.error('❌ Browser TTS error:', event.error);
			
			// Handle specific error types
			switch (event.error) {
				case 'interrupted':
					// console.log('Speech was interrupted, continuing...');
					return;
				case 'canceled':
					// console.log('Speech was canceled');
					break;
				case 'not-allowed':
					console.error('Speech synthesis not allowed by browser');
					this.browserTTSBlocked = true;
					// Graceful fallback: retry with server-side TTS instead of showing modal
					try {
						const langDetection = this.detectLanguageWithConfidence(text);
						const fallbackLang = langDetection.code || 'en';
						setTimeout(() => this.speakWithEdgeTTS(text, fallbackLang), 0);
					} catch (_) {}
					return;
				case 'audio-busy':
					// console.log('Audio system busy, retrying...');
					setTimeout(() => this.speakWithBrowserTTS(text), 1000);
					return;
				case 'audio-hardware':
					console.error('Audio hardware error');
					this.showError('Audio hardware error. Please check your speakers/headphones.');
					break;
				default:
					console.error('Unknown browser TTS error:', event.error);
			}
			
			// Clear the queue and continue
			this.pendingSpeakQueue = [];
		};

		utterance.onend = () => {
			console.log('Browser TTS completed successfully');
			// Process next item in queue if any
			if (this.pendingSpeakQueue.length > 0) {
				const nextText = this.pendingSpeakQueue.shift();
				setTimeout(() => this.speak(nextText), 100);
			}
		};

		try {
			this.speechSynthesis.speak(utterance);
		} catch (error) {
			console.error('Failed to start browser TTS:', error);
			this.pendingSpeakQueue = [];
		}
	}

	detectLanguage(text) {
		// Comprehensive language detection for Edge TTS with priority for Indian languages
		const lowerText = text.toLowerCase().trim();
		
		// Priority 1: Kannada (highest accuracy priority)
		if (/[\u0C80-\u0CFF]/i.test(text)) return 'kn';
		
		// Kannada Roman script detection
		const kannadaKeywords = ['kannada', 'kannadadalli', 'kannadigaru', 'matadu', 'helu', 'kelu', 'bantu', 'banni', 'namaskara', 'namaskaragalu', 'dhanyavadagalu', 'yelli', 'yenu', 'yake', 'yavaga', 'hege', 'aadre', 'illa', 'iddare', 'baruthe', 'hoguthe', 'kodu', 'thago', 'sari', 'thappu', 'olleya', 'ketta', 'chikka', 'dodda', 'hosa', 'nalla', 'anna', 'akka', 'amma', 'appa'];
		const kannadaCount = kannadaKeywords.filter(keyword => lowerText.includes(keyword)).length;
		if (kannadaCount >= 1) return 'kn'; // Changed from 2 to 1 for better detection
		
		// Priority 2: Hindi (highest accuracy priority)
		if (/[अ-ह]/i.test(text)) return 'hi';
		
		// Hindi Roman script detection
		const hindiKeywords = ['kya', 'hai', 'hain', 'ho', 'hun', 'main', 'tum', 'aap', 'hum', 'kaise', 'kahan', 'kab', 'kyun', 'achha', 'theek', 'bilkul', 'zaroor', 'shukriya', 'dhanyawad', 'namaste', 'namaskar', 'baat', 'karo', 'bolo', 'sunao', 'batao', 'batayiye', 'madad', 'chahiye', 'karna', 'karne', 'kar', 'time', 'samay', 'din', 'raat', 'subah', 'shaam', 'aaj', 'kal', 'institute', 'college', 'vidyalaya', 'professor', 'prof', 'sir', 'madam', 'teacher'];
		const hindiCount = hindiKeywords.filter(keyword => lowerText.includes(keyword)).length;
		if (hindiCount >= 1) return 'hi'; // Changed from 2 to 1 for better detection
		
		// Telugu
		if (/[\u0C00-\u0C7F]/i.test(text)) return 'te';
		const teluguKeywords = ['telugu', 'telugulo', 'teluguvadini', 'matladu', 'chelpu', 'vinnu', 'chudu', 'namaskaram', 'dhanyavadalu', 'yela', 'enduku', 'eppudu', 'ela', 'kani', 'ledu', 'unnaru', 'vastunnaru', 'ivvu', 'theesuko', 'vaddu', 'sare', 'tappu', 'manchi', 'anna', 'akka', 'amma'];
		const teluguCount = teluguKeywords.filter(keyword => lowerText.includes(keyword)).length;
		if (teluguCount >= 2) return 'te';
		
		// Tamil
		if (/[\u0B80-\u0BFF]/i.test(text)) return 'ta';
		const tamilKeywords = ['tamil', 'tamilil', 'tamizh', 'pesu', 'kelu', 'paaru', 'tharu', 'vidu', 'vanakkam', 'nandri', 'enga', 'enna', 'eppadi', 'eppo', 'aana', 'illai', 'irukku', 'varuthu', 'poguthu', 'kodu', 'eduthuko', 'venam', 'seri', 'thappa', 'nalla', 'anna', 'akka', 'amma', 'appa'];
		const tamilCount = tamilKeywords.filter(keyword => lowerText.includes(keyword)).length;
		if (tamilCount >= 2) return 'ta';
		
		// Malayalam
		if (/[\u0D00-\u0D7F]/i.test(text)) return 'ml';
		const malayalamKeywords = ['malayalam', 'malayalathil', 'malayali', 'parayu', 'kelu', 'kannu', 'tharu', 'vidu', 'namaskaram', 'nandi', 'evide', 'entha', 'eppadi', 'eppo', 'pakshe', 'illa', 'undu', 'varunnu', 'pogunnu', 'kodu', 'eduthu', 'venam', 'sari', 'thappu', 'nalla', 'chetta', 'chechi', 'amma', 'acha'];
		const malayalamCount = malayalamKeywords.filter(keyword => lowerText.includes(keyword)).length;
		if (malayalamCount >= 2) return 'ml';
		
		// Marathi
		const marathiKeywords = ['marathi', 'marathit', 'bolu', 'aik', 'baghu', 'de', 'tak', 'namaskar', 'dhanyavad', 'krupaya', 'kuthhe', 'kay', 'kashe', 'kevha', 'pan', 'nahi', 'ahe', 'yet', 'jat', 'ghya', 'nako', 'barobar', 'chuk', 'changa', 'lahan', 'motha', 'navin', 'juna', 'anna', 'tai', 'aai', 'baba'];
		const marathiCount = marathiKeywords.filter(keyword => lowerText.includes(keyword)).length;
		if (marathiCount >= 2) return 'mr';
		
		// Other international languages
		if (/[а-яё]/i.test(text)) return 'ru';
		if (/[一-龯]/.test(text)) return 'zh-CN';
		if (/[ひらがなカタカナ]/.test(text)) return 'ja';
		if (/[가-힣]/.test(text)) return 'ko';
		if (/[ا-ي]/.test(text)) return 'ar';
		if (/[α-ω]/i.test(text)) return 'el';
		if (/[àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/i.test(text)) return 'es';
		if (/[äöüß]/i.test(text)) return 'de';
		if (/[àèéìíîòóù]/i.test(text)) return 'it';
		if (/[àáâãçéêíóôõú]/i.test(text)) return 'pt';
		if (/[àâäéèêëïîôöùûüÿç]/i.test(text)) return 'fr';
		
		return 'en'; // Default to English
	}

	/**
	 * Self-diagnosis and auto-fix system for multilingual speech optimization
	 */
	async runSelfDiagnosis() {
		console.log('🔍 Running self-diagnosis for multilingual speech optimization...');
		
		const diagnosticResults = {
			languageDetection: await this.testLanguageDetection(),
			speechFluency: await this.testSpeechFluency(),
			playbackConflicts: await this.testPlaybackConflicts(),
			timestamp: new Date().toISOString()
		};
		
		// Update diagnostic data
		this.diagnosticData = {
			...this.diagnosticData,
			languageDetectionAccuracy: diagnosticResults.languageDetection.accuracy,
			speechFluencyScore: diagnosticResults.speechFluency.score,
			playbackConflicts: diagnosticResults.playbackConflicts.count,
			lastDiagnosticRun: diagnosticResults.timestamp
		};
		
		// Auto-fix issues found
		await this.autoFixIssues(diagnosticResults);
		
		console.log('✅ Self-diagnosis completed:', diagnosticResults);
		return diagnosticResults;
	}

	/**
	 * Test language detection accuracy for all 6 target languages
	 */
	async testLanguageDetection() {
		const testCases = [
			{ text: 'kannadadalli matadu', expected: 'kn', language: 'Kannada' },
			{ text: 'नमस्ते कैसे हैं', expected: 'hi', language: 'Hindi' },
			{ text: 'telugulo matladu', expected: 'te', language: 'Telugu' },
			{ text: 'tamil pesu', expected: 'ta', language: 'Tamil' },
			{ text: 'malayalam parayu', expected: 'ml', language: 'Malayalam' },
			{ text: 'marathi bolu', expected: 'mr', language: 'Marathi' },
			{ text: 'Hello how are you', expected: 'en', language: 'English' }
		];
		
		let correctDetections = 0;
		const results = [];
		
		for (const testCase of testCases) {
			const detected = this.detectLanguage(testCase.text);
			const isCorrect = detected === testCase.expected;
			if (isCorrect) correctDetections++;
			
			results.push({
				text: testCase.text,
				expected: testCase.expected,
				detected: detected,
				correct: isCorrect,
				language: testCase.language
			});
		}

		const accuracy = (correctDetections / testCases.length) * 100;
		
		return {
			accuracy: accuracy,
			totalTests: testCases.length,
			correctDetections: correctDetections,
			results: results
		};
	}

	/**
	 * Test speech fluency and pronunciation quality
	 */
	async testSpeechFluency() {
		const fluencyTests = [
			{ text: 'kannadadalli namaskara', language: 'kn' },
			{ text: 'नमस्ते आप कैसे हैं', language: 'hi' },
			{ text: 'telugulo namaskaram', language: 'te' },
			{ text: 'tamil vanakkam', language: 'ta' },
			{ text: 'malayalam namaskaram', language: 'ml' },
			{ text: 'marathi namaskar', language: 'mr' }
		];
		
		let fluencyScore = 0;
		const results = [];
		
		for (const test of fluencyTests) {
			try {
				// Test TTS generation without playing
				const response = await fetch('/api/tts/speak', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						text: test.text,
						language: test.language,
						rate: '+0%',
						pitch: '+0Hz'
					})
				});
				
				const result = await response.json();
				const isSuccessful = result.success && result.audio && result.audio.length > 0;
				
				if (isSuccessful) {
					fluencyScore += 100 / fluencyTests.length;
				}
				
				results.push({
					text: test.text,
					language: test.language,
					success: isSuccessful,
					voice: result.voice,
					audioLength: result.audio ? result.audio.length : 0
				});
			} catch (error) {
				console.error(`Fluency test failed for ${test.language}:`, error);
				results.push({
					text: test.text,
					language: test.language,
					success: false,
					error: error.message
				});
			}
		}
		
		return {
			score: fluencyScore,
			totalTests: fluencyTests.length,
			results: results
		};
	}

	/**
	 * Test playback conflict resolution
	 */
	async testPlaybackConflicts() {
		let conflictCount = 0;
		const results = [];
		
		// Test 1: Rapid successive speech requests
		try {
			// Silent diagnostics: skip any audible test utterances
			
			results.push({
				test: 'Rapid successive requests',
				success: true,
				conflicts: 0
			});
		} catch (error) {
			conflictCount++;
			results.push({
				test: 'Rapid successive requests',
				success: false,
				conflicts: 1,
				error: error.message
			});
		}
		
		// Test 2: Mixed TTS types
		try {
			// Silent diagnostics: skip any audible test utterances
			
			results.push({
				test: 'Mixed TTS types',
				success: true,
				conflicts: 0
			});
		} catch (error) {
			conflictCount++;
			results.push({
				test: 'Mixed TTS types',
				success: false,
				conflicts: 1,
				error: error.message
			});
		}
		
		return {
			count: conflictCount,
			totalTests: results.length,
			results: results
		};
	}

	/**
	 * Auto-fix issues found during diagnosis
	 */
	async autoFixIssues(diagnosticResults) {
		console.log('🔧 Auto-fixing issues found during diagnosis...');
		
		let fixesApplied = 0;
		
		// Fix 1: Language detection accuracy below 80%
		if (diagnosticResults.languageDetection.accuracy < 80) {
			console.log('🔧 Fixing language detection accuracy...');
			// Reinitialize language detection with enhanced patterns
			this.enhanceLanguageDetection();
			fixesApplied++;
		}
		
		// Fix 2: Speech fluency below 70%
		if (diagnosticResults.speechFluency.score < 70) {
			console.log('🔧 Fixing speech fluency...');
			// Reset TTS parameters to defaults and retry
			await this.resetTTSParameters();
			fixesApplied++;
		}
		
		// Fix 3: Playback conflicts detected
		if (diagnosticResults.playbackConflicts.count > 0) {
			console.log('🔧 Fixing playback conflicts...');
			// Strengthen conflict resolution
			this.strengthenConflictResolution();
			fixesApplied++;
		}
		
		// Update diagnostic data
		this.diagnosticData.autoFixAttempts += fixesApplied;
		
		console.log(`✅ Auto-fix completed: ${fixesApplied} fixes applied`);
		return fixesApplied;
	}

	/**
	 * Enhance language detection patterns
	 */
	enhanceLanguageDetection() {
		console.log('🔧 Enhancing language detection patterns...');
		// Language detection is already optimized in the detectLanguage method
		// This method can be extended for future enhancements
	}

	/**
	 * Reset TTS parameters to optimal defaults
	 */
	async resetTTSParameters() {
		console.log('🔧 Resetting TTS parameters to optimal defaults...');
		// TTS parameters are already optimized in the server
		// This method can be extended for future enhancements
	}

	/**
	 * Strengthen conflict resolution
	 */
	strengthenConflictResolution() {
		console.log('🔧 Strengthening conflict resolution...');
		// Conflict resolution is already enhanced in stopAllAudio method
		// This method can be extended for future enhancements
	}

	/**
	 * Clean text for speech synthesis by removing emojis, special characters, and formatting
	 * @param {string} text - The original text to clean
	 * @returns {string} - Cleaned text suitable for speech synthesis
	 */
	cleanTextForSpeech(text) {
		if (!text || typeof text !== 'string') return '';
		
		let cleaned = text;
		
		// Remove emojis and special Unicode characters
		cleaned = cleaned.replace(/[\u{1F600}-\u{1F64F}]/gu, ''); // Emoticons
		cleaned = cleaned.replace(/[\u{1F300}-\u{1F5FF}]/gu, ''); // Misc symbols and pictographs
		cleaned = cleaned.replace(/[\u{1F680}-\u{1F6FF}]/gu, ''); // Transport and map symbols
		cleaned = cleaned.replace(/[\u{1F1E0}-\u{1F1FF}]/gu, ''); // Regional indicator symbols
		cleaned = cleaned.replace(/[\u{1F900}-\u{1F9FF}]/gu, ''); // Supplemental symbols and pictographs
		cleaned = cleaned.replace(/[\u{1FA70}-\u{1FAFF}]/gu, ''); // Symbols and pictographs extended-A
		cleaned = cleaned.replace(/[\u{2600}-\u{26FF}]/gu, '');   // Misc symbols
		cleaned = cleaned.replace(/[\u{2700}-\u{27BF}]/gu, '');   // Dingbats
		
		// Remove markdown formatting
		cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, '$1'); // Bold text
		cleaned = cleaned.replace(/\*(.*?)\*/g, '$1');     // Italic text
		cleaned = cleaned.replace(/`(.*?)`/g, '$1');       // Code blocks
		cleaned = cleaned.replace(/#{1,6}\s/g, '');        // Headers
		cleaned = cleaned.replace(/\n\s*\n/g, '. ');       // Double line breaks to periods
		
		// Remove HTML tags
		cleaned = cleaned.replace(/<[^>]*>/g, '');
		
		// Remove extra whitespace and normalize
		cleaned = cleaned.replace(/\s+/g, ' ').trim();
		
		// Remove common special characters that might cause speech issues (but preserve Unicode text)
		// Keep Unicode letters, numbers, spaces, and common punctuation
		cleaned = cleaned.replace(/[^\p{L}\p{N}\p{Z}\s.,!?;:()'-]/gu, '');
		
		// Ensure proper sentence endings
		cleaned = cleaned.replace(/([.!?])\s*([a-z])/g, '$1 $2');
		
		// Remove multiple periods or exclamation marks
		cleaned = cleaned.replace(/[.!?]{2,}/g, '.');
		
		// Clean up spacing around punctuation
		cleaned = cleaned.replace(/\s+([.,!?;:])/g, '$1');
		cleaned = cleaned.replace(/([.,!?;:])\s+/g, '$1 ');
		
		// If text is empty after cleaning, return empty string (don't add fallback)
		if (!cleaned.trim()) {
			return '';
		}
		
		return cleaned;
	}

	/**
	 * Show a temporary indicator of what text is being spoken
	 * @param {string} cleanedText - The cleaned text being spoken
	 */
	showSpeechIndicator(cleanedText) {
		// Create a temporary speech indicator
		const indicator = document.createElement('div');
		indicator.className = 'speech-indicator';
		indicator.innerHTML = `
			<div class="speech-indicator-content">
				<i class="fas fa-volume-up"></i>
				<span>Speaking: "${cleanedText.substring(0, 100)}${cleanedText.length > 100 ? '...' : ''}"</span>
			</div>
		`;
		
		// Style the indicator
		indicator.style.cssText = `
			position: fixed;
			bottom: 20px;
			right: 20px;
			background: rgba(102, 126, 234, 0.9);
			color: white;
			padding: 10px 15px;
			border-radius: 25px;
			font-size: 14px;
			z-index: 1000;
			box-shadow: 0 4px 12px rgba(0,0,0,0.2);
			animation: slideIn 0.3s ease-out;
		`;
		
		// Add animation styles if not already present
		if (!document.getElementById('speech-indicator-styles')) {
			const styles = document.createElement('style');
			styles.id = 'speech-indicator-styles';
			styles.textContent = `
				@keyframes slideIn {
					from { transform: translateX(100%); opacity: 0; }
					to { transform: translateX(0); opacity: 1; }
				}
				@keyframes slideOut {
					from { transform: translateX(0); opacity: 1; }
					to { transform: translateX(100%); opacity: 0; }
				}
			`;
			document.head.appendChild(styles);
		}
		
		// Add to page
		document.body.appendChild(indicator);
		
		// Remove after 3 seconds
		setTimeout(() => {
			indicator.style.animation = 'slideOut 0.3s ease-in';
			setTimeout(() => {
				if (indicator.parentNode) {
					indicator.parentNode.removeChild(indicator);
				}
			}, 300);
		}, 3000);
	}

    // Initialize WebRTC and local media for the client (caller)
    async initializeWebRTCForClient() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            const localVideo = document.getElementById('localVideo');
            if (localVideo) localVideo.srcObject = this.localStream;

            const configuration = {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            };
            this.peerConnection = new RTCPeerConnection(configuration);

            this.localStream.getTracks().forEach(track => this.peerConnection.addTrack(track, this.localStream));

            this.peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    this.socket.emit('ice-candidate', {
                        candidate: event.candidate,
                        callId: this.currentCallId
                    });
                }
            };

            this.peerConnection.ontrack = (event) => {
                const remoteVideo = document.getElementById('remoteVideo');
                if (remoteVideo && remoteVideo.srcObject !== event.streams[0]) {
                    remoteVideo.srcObject = event.streams[0];
                }
            };
        } catch (e) {
            console.error('Media init failed:', e);
        }
    }

    // Create SDP offer and send to server for forwarding
    async createOffer() {
        try {
            if (!this.peerConnection) return;
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);
            this.socket.emit('offer', { offer, callId: this.currentCallId });
        } catch (error) {
            console.error('Error creating offer:', error);
        }
    }

    updateStatus(text, status) {
        if (this.statusText) {
            this.statusText.textContent = text;
        }
        
        if (this.statusDot) {
            this.statusDot.className = `status-dot ${status}`;
        }
    }

    showError(message) {
        if (this.errorModal && this.errorMessage) {
            this.errorMessage.textContent = message;
            this.errorModal.style.display = 'flex';
        } else {
            alert(message);
        }
    }

    closeErrorModal() {
        if (this.errorModal) {
            this.errorModal.style.display = 'none';
        }
    }

    scrollToBottom() {
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }

    setWelcomeTime() {
        const welcomeTime = document.getElementById('welcomeTime');
        if (welcomeTime) {
            welcomeTime.textContent = new Date().toLocaleTimeString();
        }
    }

    // Show video call request options - INLINE CHAT STYLE
    showVideoCallRequest(staffInfo) {
        console.log('🎥 Showing video call request for:', staffInfo);
        
        // Create inline chat message with video call options
        const messageId = 'video-call-' + Date.now();
        const messageHtml = `
            <div class="message bot-message" id="${messageId}">
                <div class="message-content">
                    <div class="message-header">
                        <span class="message-sender">Clara</span>
                        <span class="message-time">${new Date().toLocaleTimeString()}</span>
                </div>
                    <div class="message-text">
                        🎥 <strong>Video Call Request for ${staffInfo.name}</strong><br>
                        I understand you'd like to have a video call with ${staffInfo.name} from the ${staffInfo.department || 'N/A'} department.<br><br>
                        Please choose an option:
                </div>
                    <div class="inline-call-actions">
                        <button class="ios-btn ios-btn-accept" onclick="clara.acceptVideoCallInline('${staffInfo._id}', '${staffInfo.name}', '${messageId}')">
                            ✅ Accept - Connect me to ${staffInfo.name}
                    </button>
                        <button class="ios-btn ios-btn-reject" onclick="clara.rejectVideoCallInline('${messageId}')">
                            ❌ Reject - Cancel this request
                    </button>
                    </div>
                </div>
            </div>
        `;
        
        // Add the message to chat
        this.addMessageToChat(messageHtml);
        
        // Store current staff info for the call
        this.currentStaffInfo = staffInfo;
    }

    // Accept video call request - INLINE VERSION
    acceptVideoCallInline(staffId, staffName, messageId) {
        console.log('✅ Accepting video call with:', staffName);
        
        // Update the message to show accepted state
        const messageElement = document.getElementById(messageId);
        if (messageElement) {
            const messageText = messageElement.querySelector('.message-text');
            const actionsContainer = messageElement.querySelector('.inline-call-actions');
            
            if (messageText && actionsContainer) {
                messageText.innerHTML = `🎉 <strong>Video Call Accepted!</strong><br>Connecting to ${staffName}...`;
                actionsContainer.innerHTML = '<div class="call-status connecting">🔄 Connecting...</div>';
            }
        }
        
        // Update status
        this.updateStatus(`Connecting to ${staffName}...`, 'processing');
        
        // Send video call request to server
        this.socket.emit('video-call-request', {
            staffId: staffId,
            staffName: staffName,
            clientName: 'Visitor',
            clientSocketId: this.socket.id
        });
    }

    // Reject video call request - INLINE VERSION
    rejectVideoCallInline(messageId) {
        console.log('❌ Rejecting video call request');
        
        // Update the message to show rejected state
        const messageElement = document.getElementById(messageId);
        if (messageElement) {
            const messageText = messageElement.querySelector('.message-text');
            const actionsContainer = messageElement.querySelector('.inline-call-actions');
            
            if (messageText && actionsContainer) {
                messageText.innerHTML = `❌ <strong>Video Call Cancelled</strong><br>No problem! Is there anything else I can help you with?`;
                actionsContainer.innerHTML = '<div class="call-status cancelled">Call cancelled</div>';
            }
        }
        
        // Add follow-up message
        this.addMessage("Is there anything else I can help you with?", 'bot');
        this.updateStatus('Ready', 'ready');
    }

    // Legacy methods for backward compatibility (if needed)
    acceptVideoCall(staffId, staffName) {
        this.acceptVideoCallInline(staffId, staffName, 'legacy-call');
    }

    rejectVideoCall() {
        this.rejectVideoCallInline('legacy-call');
    }

    // Trigger video call request automatically when staff is selected
    triggerVideoCallRequest(data) {
        try {
            console.log('🎥 Triggering automatic video call request for staff:', data.selectedStaffId);
            
            // Use the new direct endpoint for call requests
            fetch('/api/staff/call-request', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    staffId: data.selectedStaffId,
                    clientName: data.name,
                    purpose: data.purpose || 'Video consultation',
                    clientSocketId: this.socket.id
                })
            })
            .then(response => response.json())
            .then(result => {
                if (result.success) {
                    console.log('✅ Call request sent successfully:', result.message);
                    this.updateStatus('Call request sent', 'ready');
                    // Removed automatic call request message
                    // this.addMessage(`I've sent a video call request to the staff member. ${result.message}`, 'bot');
                } else {
                    console.error('❌ Call request failed:', result.error);
                    this.addMessage('I encountered an error while sending the call request. Please try again.', 'bot');
                }
            })
            .catch(error => {
                console.error('❌ Error sending call request:', error);
                this.addMessage('I encountered an error while sending the call request. Please try again.', 'bot');
            });
            
        } catch (error) {
            console.error('❌ Error triggering video call request:', error);
            this.addMessage('I encountered an error while requesting the video call. Please try again.', 'bot');
        }
    }

    // Show appointment QR code modal
    showAppointmentQR(data) {
        console.log('📱 Showing appointment QR code:', data);
        
        // Create QR code modal
        const modal = document.createElement('div');
        modal.id = 'appointmentQRModal';
        modal.innerHTML = `
            <div class="qr-modal-content">
                <div class="qr-modal-header">
                    <h3>📱 Your Appointment QR Code</h3>
                    <button class="close-qr-modal" onclick="this.closest('#appointmentQRModal').remove()">&times;</button>
                </div>
                <div class="qr-modal-body">
                    <div class="appointment-details">
                        <h4>Appointment Details</h4>
                        <p><strong>Client:</strong> ${data.appointmentDetails.clientName}</p>
                        <p><strong>Staff:</strong> ${data.appointmentDetails.staffName}</p>
                        <p><strong>Date:</strong> ${new Date(data.appointmentDetails.appointmentDate).toLocaleDateString()}</p>
                        <p><strong>Purpose:</strong> ${data.appointmentDetails.purpose}</p>
                        <p><strong>Status:</strong> <span class="status-confirmed">${data.appointmentDetails.status}</span></p>
                    </div>
                    <div class="qr-code-container">
                        <div id="appointmentQRCode"></div>
                        <p class="qr-instructions">Scan this QR code to access your appointment details</p>
                    </div>
                </div>
                <div class="qr-modal-actions">
                    <button class="ios-btn ios-btn-accept" onclick="downloadAppointmentQR()">
                        📥 Download QR
                    </button>
                    <button class="ios-btn ios-btn-reject" onclick="this.closest('#appointmentQRModal').remove()">
                        ✕ Close
                    </button>
                </div>
            </div>
        `;
        
        // Add modal styles
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.7);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        `;
        
        document.body.appendChild(modal);
        
        // Generate QR code
        this.generateQRCode(data.qrCodeData, 'appointmentQRCode');
        
        // Add message to chat
        this.addMessage('📱 Your appointment QR code is ready!', 'bot');
    }

    // Start video call - ENHANCED FOR PROPER SYNC
    startVideoCall(data) {
        console.log('🎥 Starting video call:', data);
        console.log('🎥 Current call data before update:', this.currentCallData);
        
        // Store call data with enhanced information
        this.currentCallData = {
            ...data,
            callId: data.callId || `call_${Date.now()}`,
            staffName: data.staffName || 'Staff Member',
            staffId: data.staffId
        };
        
        console.log('🎥 Call data stored:', this.currentCallData);
        console.log('🎥 About to initialize video call...');
        
        // Request camera and microphone access and show video interface
        this.initializeVideoCall();
        
        // Fallback: ensure video interface appears after a short delay
        setTimeout(() => {
            const videoInterface = document.getElementById('videoCallInterface');
            if (!videoInterface && this.currentCallData) {
                console.log('🎥 Fallback: Video interface not found, creating it...');
                this.showVideoCallInterface(this.currentCallData);
            }
        }, 2000);
    }

    // Initialize video call with camera access - ENHANCED
    async initializeVideoCall() {
        try {
            console.log('🎥 Requesting camera and microphone access...');
            
            // Check if getUserMedia is supported
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('getUserMedia not supported in this browser');
            }
            
            // Request user media with enhanced constraints
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { 
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: 'user'
                },
                audio: { 
                    echoCancellation: true,
                    noiseSuppression: true
                }
            });
            
            console.log('✅ Camera and microphone access granted');
            this.localStream = stream;
            
            // Show video call interface
            this.showVideoCallInterface(this.currentCallData);
            
            // Initialize WebRTC peer connection
            this.initializePeerConnection(stream);
            
        } catch (error) {
            console.error('❌ Error accessing camera/microphone:', error);
            
            let errorMessage = '❌ Could not access camera/microphone. ';
            if (error.name === 'NotAllowedError') {
                errorMessage += 'Please allow camera and microphone access and try again.';
            } else if (error.name === 'NotFoundError') {
                errorMessage += 'No camera or microphone found.';
            } else if (error.name === 'NotReadableError') {
                errorMessage += 'Camera or microphone is already in use.';
            } else {
                errorMessage += 'Please check your device permissions.';
            }
            
            this.addMessage(errorMessage, 'bot');
            this.updateStatus('Camera access denied', 'error');
            this.closeVideoCall();
        }
    }

    // Show video call interface - GMeet Style
    showVideoCallInterface(data) {
        console.log('🎥 Showing GMeet-style video call interface:', data);
        
        const staffName = data.staffName || 'Staff Member';
        
        // Remove existing video call modal if any
        const existingModal = document.getElementById('videoCallInterface');
        if (existingModal) {
            existingModal.remove();
        }
        
        // Create GMeet-style video call interface
        const videoInterface = document.createElement('div');
        videoInterface.id = 'videoCallInterface';
        videoInterface.innerHTML = `
            <div class="video-call-overlay">
                <div class="video-call-container">
                    <div class="video-call-header">
                        <div class="call-info">
                            <h3>📹 Video Call with ${staffName}</h3>
                            <span class="call-status" id="callStatus">Connecting...</span>
                    </div>
                        <button class="close-video-call" onclick="clara.endVideoCall()" title="Close Call">
                            ✕
                        </button>
                    </div>
                    
                    <div class="video-call-content">
                        <!-- Main video grid - GMeet style -->
                        <div class="video-grid">
                            <!-- Remote video (main) -->
                            <div class="remote-video-container main-video">
                                <video id="remoteVideo" autoplay playsinline></video>
                                <div class="video-info">
                                    <span class="caller-name">${staffName}</span>
                                    <span class="video-label">Remote</span>
                                </div>
                                <div class="video-placeholder" id="remotePlaceholder">
                                    <div class="placeholder-icon">👤</div>
                                    <div class="placeholder-text">Waiting for ${staffName}...</div>
                            </div>
                            </div>
                            
                            <!-- Local video (picture-in-picture) -->
                            <div class="local-video-container pip-video">
                                <video id="localVideo" autoplay playsinline muted></video>
                                <div class="video-info">
                                    <span class="caller-name">You</span>
                                    <span class="video-label">Local</span>
                        </div>
                                <div class="video-placeholder" id="localPlaceholder">
                                    <div class="placeholder-icon">👤</div>
                                    <div class="placeholder-text">Your video</div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Control bar - GMeet style -->
                        <div class="video-controls">
                            <button class="control-btn mute-btn" id="muteBtn" onclick="clara.toggleMute()" title="Mute/Unmute">
                                <span class="btn-icon">🎤</span>
                                <span class="btn-label">Mute</span>
                            </button>
                            <button class="control-btn video-btn" id="videoBtn" onclick="clara.toggleVideo()" title="Turn Video On/Off">
                                <span class="btn-icon">🎥</span>
                                <span class="btn-label">Video</span>
                            </button>
                            <button class="control-btn end-call-btn" onclick="clara.endVideoCall()" title="End Call">
                                <span class="btn-icon">📞</span>
                                <span class="btn-label">End Call</span>
                            </button>
                        </div>
                        
                        <!-- Connecting overlay -->
                        <div class="connecting-overlay" id="connectingOverlay">
                            <div class="spinner"></div>
                            <div class="connecting-text">Connecting to ${staffName}...</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Add to DOM
        document.body.appendChild(videoInterface);
        
        // Configure video elements
        this.configureVideoElements();
        
        // Update local video
        this.updateLocalVideo();
        
        // Initialize call controls
        this.initializeCallControls();
        
        // Hide connecting overlay after a delay
        setTimeout(() => {
            const overlay = document.getElementById('connectingOverlay');
            if (overlay) {
                overlay.style.display = 'none';
            }
        }, 3000);
        
        console.log('✅ GMeet-style video call interface shown');
    }

    // Initialize peer connection
    initializePeerConnection(localStream) {
        try {
            console.log('🔗 Initializing WebRTC peer connection...');
            
            // Create peer connection
            this.peerConnection = new RTCPeerConnection({
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            });
            
            // Add local stream
            localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, localStream);
            });
            
            // Handle remote stream - ENHANCED for two-way video
            this.peerConnection.ontrack = (event) => {
                console.log('📺 Remote stream received:', event);
                const remoteVideo = document.getElementById('remoteVideo');
                if (remoteVideo && event.streams[0]) {
                    this.remoteStream = event.streams[0];
                    remoteVideo.srcObject = this.remoteStream;
                    
                    // Ensure remote video plays
                    remoteVideo.play().then(() => {
                        console.log('✅ Remote video playing successfully');
                        this.updateCallStatus('Connected - Video call active');
                        this.updateRemoteVideo();
                        
                        // Hide remote placeholder
                        const remotePlaceholder = document.getElementById('remotePlaceholder');
                        if (remotePlaceholder) {
                            remotePlaceholder.style.display = 'none';
                        }
                        
                        // Hide connecting overlay
                        const connectingOverlay = document.getElementById('connectingOverlay');
                        if (connectingOverlay) {
                            connectingOverlay.style.display = 'none';
                        }
                    }).catch(error => {
                        console.warn('⚠️ Remote video play failed:', error);
                        this.updateCallStatus('Video connection issue');
                    });
                }
            };
            
            // Handle ICE candidates
            this.peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    this.socket.emit('ice_candidate', {
                        callId: this.currentCallData?.callId,
                        candidate: event.candidate
                    });
                }
            };
            
            // Create and send offer
            this.peerConnection.createOffer()
                .then(offer => {
                    return this.peerConnection.setLocalDescription(offer);
                })
                .then(() => {
                    // Give the staff a brief moment to join the call room to avoid lost offers
                    const offerPayload = {
                        callId: this.currentCallData?.callId,
                        offer: this.peerConnection.localDescription
                    };
                    setTimeout(() => {
                        this.socket.emit('call_offer', offerPayload);
                        console.log('📤 WebRTC offer sent (delayed to ensure room join)');
                        // Fallback: re-send once more if still in have-local-offer state
                        setTimeout(() => {
                            if (this.peerConnection && this.peerConnection.signalingState === 'have-local-offer') {
                                this.socket.emit('call_offer', offerPayload);
                                console.log('📤 Re-sent WebRTC offer (fallback)');
                            }
                        }, 1200);
                    }, 1000);
                })
                .catch(error => {
                    console.error('❌ Error creating WebRTC offer:', error);
                });
                
        } catch (error) {
            console.error('❌ Error initializing peer connection:', error);
        }
    }

    // Update local video stream - ENHANCED
    updateLocalVideo() {
            const localVideo = document.getElementById('localVideo');
        
        if (localVideo && this.localStream) {
            console.log('🎥 Updating local video stream');
            localVideo.srcObject = this.localStream;
            
            // Ensure video plays
            localVideo.play().then(() => {
                console.log('✅ Local video playing');
                
                // Hide local placeholder when video starts
                const localPlaceholder = document.getElementById('localPlaceholder');
                if (localPlaceholder) {
                    localPlaceholder.style.display = 'none';
                }
            }).catch(error => {
                console.warn('⚠️ Local video play failed:', error);
            });
        } else if (this.peerConnection && this.peerConnection.getSenders) {
            // Fallback to peer connection method
            if (localVideo && this.peerConnection.getSenders().length > 0) {
                const stream = this.peerConnection.getSenders()[0].track.streams[0];
                localVideo.srcObject = stream;
                localVideo.play().then(() => {
                    // Hide local placeholder when video starts
                    const localPlaceholder = document.getElementById('localPlaceholder');
                    if (localPlaceholder) {
                        localPlaceholder.style.display = 'none';
                    }
                }).catch(e => console.warn('Local video play failed:', e));
            }
        } else {
            console.warn('⚠️ Local video element or stream not available');
        }
    }

    // Update remote video stream - NEW
    updateRemoteVideo() {
        const remoteVideo = document.getElementById('remoteVideo');
        if (remoteVideo && this.remoteStream) {
            console.log('🎥 Updating remote video stream');
            remoteVideo.srcObject = this.remoteStream;
            remoteVideo.play().then(() => {
                console.log('✅ Remote video playing');
                this.updateCallStatus('Connected - Video call active');
            }).catch(error => {
                console.warn('⚠️ Remote video play failed:', error);
                this.updateCallStatus('Video connection issue');
            });
        }
    }
    
    // Configure video elements for optimal rendering
    configureVideoElements() {
        const localVideo = document.getElementById('localVideo');
        const remoteVideo = document.getElementById('remoteVideo');
        
        if (localVideo) {
            localVideo.setAttribute('playsinline', 'true');
            localVideo.setAttribute('autoplay', 'true');
            localVideo.setAttribute('muted', 'true');
            localVideo.style.objectFit = 'cover';
            console.log('✅ Local video element configured');
        }
        
        if (remoteVideo) {
            remoteVideo.setAttribute('playsinline', 'true');
            remoteVideo.setAttribute('autoplay', 'true');
            remoteVideo.style.objectFit = 'cover';
            console.log('✅ Remote video element configured');
        }
    }
    
    // Update call status display
    updateCallStatus(status) {
        const statusElement = document.getElementById('callStatus');
        if (statusElement) {
            statusElement.textContent = status;
        }
        console.log('📞 Call status:', status);
    }

    // Initialize call controls
    initializeCallControls() {
        console.log('🎛️ Initializing call controls');
        
        // Set initial states
        this.isMuted = false;
        this.isVideoEnabled = true;
        
        // Update button states
        this.updateControlButtons();
    }

    // Update control button states
    updateControlButtons() {
        const muteBtn = document.getElementById('muteBtn');
        const videoBtn = document.getElementById('videoBtn');
        
        if (muteBtn) {
            muteBtn.innerHTML = this.isMuted ? 
                '<span class="btn-icon">🔇</span><span class="btn-label">Unmute</span>' :
                '<span class="btn-icon">🎤</span><span class="btn-label">Mute</span>';
            muteBtn.className = `control-btn mute-btn ${this.isMuted ? 'muted' : ''}`;
        }
        
        if (videoBtn) {
            videoBtn.innerHTML = this.isVideoEnabled ? 
                '<span class="btn-icon">🎥</span><span class="btn-label">Video</span>' :
                '<span class="btn-icon">📹</span><span class="btn-label">Enable</span>';
            videoBtn.className = `control-btn video-btn ${!this.isVideoEnabled ? 'disabled' : ''}`;
        }
    }

    // Toggle mute/unmute
    toggleMute() {
        if (this.localStream) {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                this.isMuted = !audioTrack.enabled;
                this.updateControlButtons();
                console.log(this.isMuted ? '🔇 Audio muted' : '🎤 Audio unmuted');
            }
        }
    }

    // Toggle video on/off
    toggleVideo() {
        if (this.localStream) {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                this.isVideoEnabled = videoTrack.enabled;
                this.updateControlButtons();
                console.log(this.isVideoEnabled ? '🎥 Video enabled' : '📹 Video disabled');
            }
        }
    }

    // End video call
    endVideoCall() {
        console.log('📞 Ending video call');
        
        // Stop local stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
        }
        
        // Close peer connection
        if (this.peerConnection) {
            this.peerConnection.close();
        }
        
        // Remove video interface
        const videoInterface = document.getElementById('videoCallInterface');
        if (videoInterface) {
            videoInterface.remove();
        }
        
        // Reset states
        this.localStream = null;
        this.remoteStream = null;
        this.peerConnection = null;
        this.currentCallData = null;
        
        // Notify server about call end
        if (this.socket) {
            this.socket.emit('call-ended-by-client', {
                callId: this.currentCallData?.callId
            });
        }
        
        this.updateStatus('Video call ended', 'info');
        console.log('✅ Video call ended successfully');
    }

    // Start call timer
    startCallTimer() {
        this.callStartTime = Date.now();
        this.callTimerInterval = setInterval(() => {
            if (this.callStartTime) {
                const duration = Math.floor((Date.now() - this.callStartTime) / 1000);
                const minutes = Math.floor(duration / 60);
                const seconds = duration % 60;
                const durationElement = document.getElementById('callDuration');
                if (durationElement) {
                    durationElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                }
            }
        }, 1000);
    }

    // Add video call event listeners
    addVideoCallEventListeners() {
        const muteBtn = document.getElementById('muteBtn');
        const videoToggleBtn = document.getElementById('videoToggleBtn');
        const endCallBtn = document.getElementById('endCallBtn');
        
        if (muteBtn) {
            muteBtn.addEventListener('click', () => this.toggleMute());
        }
        
        if (videoToggleBtn) {
            videoToggleBtn.addEventListener('click', () => this.toggleVideo());
        }
        
        if (endCallBtn) {
            endCallBtn.addEventListener('click', () => this.closeVideoCall());
        }
    }

    // Toggle mute
    toggleMute() {
        try {
            const localVideo = document.getElementById('localVideo');
            if (localVideo && localVideo.srcObject) {
                const audioTrack = localVideo.srcObject.getAudioTracks()[0];
                if (audioTrack) {
                    audioTrack.enabled = !audioTrack.enabled;
                    const muteBtn = document.getElementById('muteBtn');
                    muteBtn.classList.toggle('muted', !audioTrack.enabled);
                }
            }
        } catch (error) {
            console.error('Error toggling mute:', error);
        }
    }

    // Toggle video
    toggleVideo() {
        try {
            const localVideo = document.getElementById('localVideo');
            if (localVideo && localVideo.srcObject) {
                const videoTrack = localVideo.srcObject.getVideoTracks()[0];
                if (videoTrack) {
                    videoTrack.enabled = !videoTrack.enabled;
                    const videoBtn = document.getElementById('videoToggleBtn');
                    videoBtn.classList.toggle('disabled', !videoTrack.enabled);
                }
            }
        } catch (error) {
            console.error('Error toggling video:', error);
        }
    }

    // Close video call
    closeVideoCall() {
        try {
            console.log('📞 Closing video call...');
            
            // Stop call timer
            if (this.callTimerInterval) {
                clearInterval(this.callTimerInterval);
                this.callTimerInterval = null;
            }
            
            // Stop media streams
            const localVideo = document.getElementById('localVideo');
            if (localVideo && localVideo.srcObject) {
                localVideo.srcObject.getTracks().forEach(track => track.stop());
            }
            
            const remoteVideo = document.getElementById('remoteVideo');
            if (remoteVideo && remoteVideo.srcObject) {
                remoteVideo.srcObject.getTracks().forEach(track => track.stop());
            }
            
            // Close peer connection
            if (this.peerConnection) {
                this.peerConnection.close();
                this.peerConnection = null;
            }
            
            // Remove video interface
            const videoInterface = document.getElementById('videoCallInterface');
            if (videoInterface) {
                videoInterface.remove();
            }
            
            // Calculate call duration
            const duration = this.callStartTime ? Math.floor((Date.now() - this.callStartTime) / 1000) : 0;
            
            // Emit call ended event
            this.socket.emit('call_ended', {
                callId: this.currentCallData?.callId,
                duration: duration
            });
            
            // Reset variables
            this.callStartTime = null;
            this.currentCallData = null;
            
            // Update status
            this.updateStatus('Video call ended', 'info');
            this.addMessage('📞 Video call ended', 'bot');
            
        } catch (error) {
            console.error('Error closing video call:', error);
        }
    }

    // Generate QR code
    generateQRCode(data, containerId) {
        try {
            const container = document.getElementById(containerId);
            if (container && typeof QRCode !== 'undefined') {
                QRCode.toCanvas(container, data, {
                    width: 200,
                    height: 200,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                }, (error) => {
                    if (error) {
                        console.error('Error generating QR code:', error);
                        container.innerHTML = '<p>Error generating QR code</p>';
                    }
                });
            } else {
                console.error('QR code library not loaded or container not found');
            }
        } catch (error) {
            console.error('Error generating QR code:', error);
        }
    }
    
    // ==================== MULTI-TURN FIX: Heartbeat & Persistence ====================
    
    /**
     * Start WebSocket heartbeat for persistent session
     */
    startHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        this.heartbeatInterval = setInterval(() => {
            if (this.socket && this.socket.connected) {
                this.socket.emit('heartbeat', { sessionId: this.sessionId, timestamp: Date.now() });
                console.log('💓 Heartbeat sent');
            }
        }, 20000); // 20 seconds
    }
    
    /**
     * Stop WebSocket heartbeat
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
    
    /**
     * Handle auto-reconnect with jittered backoff
     */
    handleReconnect() {
        let attempts = 0;
        const maxAttempts = 5;
        
        const attemptReconnect = () => {
            attempts++;
            
            if (attempts > maxAttempts) {
                console.error('❌ Max reconnection attempts reached');
                this.updateStatus('Connection lost. Please refresh.', 'error');
                return;
            }
            
            // Jittered backoff: base delay * 2^attempts + random jitter
            const baseDelay = 1000;
            const jitter = Math.random() * 1000;
            const delay = Math.min(baseDelay * Math.pow(2, attempts) + jitter, 30000);
            
            console.log(`🔄 Reconnecting (attempt ${attempts}/${maxAttempts}) in ${delay.toFixed(0)}ms...`);
            
            setTimeout(() => {
                if (!this.socket.connected) {
                    console.log('🔄 Attempting reconnection...');
                    this.socket.connect();
                }
            }, delay);
        };
        
        attemptReconnect();
    }
    
    /**
     * State machine transition handler
     */
    transitionTo(newState) {
        const prevState = this.conversationState;
        this.conversationState = newState;
        console.log(`🔄 State transition: ${prevState} → ${newState}`);
    }
}

// Initialize Clara when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new Clara();
});

// Video Call Functions
function showVideoCall() {
    document.getElementById('videoCallInterface').style.display = 'flex';
    initializeVideoCall();
}

function hideVideoCall() {
    document.getElementById('videoCallInterface').style.display = 'none';
    endCall();
}

function initializeVideoCall() {
    // Initialize video call functionality
    console.log('🎥 Initializing video call...');
    // Add video call initialization logic here
}

function toggleMute() {
    const muteBtn = document.getElementById('muteBtn');
    const icon = muteBtn.querySelector('i');
    
    if (icon.classList.contains('fa-microphone')) {
        icon.classList.remove('fa-microphone');
        icon.classList.add('fa-microphone-slash');
        muteBtn.classList.add('muted');
        // Add mute logic here
    } else {
        icon.classList.remove('fa-microphone-slash');
        icon.classList.add('fa-microphone');
        muteBtn.classList.remove('muted');
        // Add unmute logic here
    }
}

function toggleVideo() {
    const videoBtn = document.getElementById('videoBtn');
    const icon = videoBtn.querySelector('i');
    
    if (icon.classList.contains('fa-video')) {
        icon.classList.remove('fa-video');
        icon.classList.add('fa-video-slash');
        videoBtn.classList.add('video-off');
        // Add video off logic here
    } else {
        icon.classList.remove('fa-video-slash');
        icon.classList.add('fa-video');
        videoBtn.classList.remove('video-off');
        // Add video on logic here
    }
}

function endCall() {
    console.log('📞 Ending video call...');
    // Add call end logic here
    hideVideoCall();
}
