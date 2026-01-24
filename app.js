// --- SUPABASE CONFIG ---
// TODO: REPLACE THESE WITH YOUR KEYS FROM SUPABASE DASHBOARD
const SUPABASE_URL = 'https://ipqeypamceftcbkjoeuf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlwcWV5cGFtY2VmdGNia2pvZXVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5Njk2NjcsImV4cCI6MjA4NDU0NTY2N30.94Y_SlOqMb-NLgm_MN57KeKSyTC3AKPhlJ7zLEKuKvs';

// Initialize Client
let supabaseClient;
try {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
    console.warn('Supabase client failed to initialize. Check keys.');
}

// --- CONSTANTS ---
const GENRES = [
    'Rock', 'Pop', 'Hip-Hop', 'Country', 'Jazz', 'Electronic',
    '80s Classics', '90s Hits', '2000s Throwback', 'Indie',
    'R&B', 'Dance', 'Chill Vibes', 'Party Anthems', 'Love Songs',
    'Guilty Pleasures', 'One-Hit Wonders', 'Movie Soundtracks'
];

// --- STATE ---
const state = {
    user: JSON.parse(localStorage.getItem('songwars_user')) || null, // { name, id }
    roomCode: null,
    isHost: false,
    currentScreen: 'landing-section',
    room: null, // Local copy of room state
    channel: null, // Realtime subscription
    lastSongIndex: -1,
    genreSpun: false
};

// --- DOM ELEMENTS ---
const screens = document.querySelectorAll('.screen');
const playerNameInput = document.getElementById('player-name');
const roomCodeInput = document.getElementById('room-code');
const displayRoomCode = document.getElementById('display-room-code');

// --- NAVIGATION ---
function showScreen(screenId) {
    screens.forEach(s => s.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');
    state.currentScreen = screenId;
}

// --- LOGIC ---
function init() {
    lucide.createIcons();

    // Restore session if exists
    if (state.user) {
        playerNameInput.value = state.user.name;
    }

    // Check URL for room code (e.g. ?room=ABCD)
    const urlParams = new URLSearchParams(window.location.search);
    const roomFromUrl = urlParams.get('room');
    if (roomFromUrl && state.user) {
        joinRoom(roomFromUrl, state.user.name);
    }

    // Load open lobbies
    loadOpenLobbies();
}

async function loadOpenLobbies() {
    const lobbyList = document.getElementById('lobby-list');
    if (!lobbyList) return;

    try {
        const { data: rooms, error } = await supabaseClient
            .from('rooms')
            .select('code, players, settings')
            .eq('status', 'LOBBY');

        if (error) throw error;

        if (!rooms || rooms.length === 0) {
            lobbyList.innerHTML = '<li class="info-text" style="opacity: 0.5;">No open lobbies</li>';
            return;
        }

        lobbyList.innerHTML = '';
        rooms.forEach(room => {
            const li = document.createElement('li');
            li.style.cursor = 'pointer';
            li.innerHTML = `
                <span><strong>${room.code}</strong> - ${room.players.length} player(s)</span>
                <span style="color: var(--accent);">Join →</span>
            `;
            li.onclick = () => {
                document.getElementById('room-code').value = room.code;
                document.querySelector('.input-group').classList.add('hidden');
                document.getElementById('join-input-group').classList.remove('hidden');
            };
            lobbyList.appendChild(li);
        });
    } catch (e) {
        console.error('Failed to load lobbies:', e);
        lobbyList.innerHTML = '<li class="info-text" style="opacity: 0.5;">Failed to load</li>';
    }
}

async function createRoom() {
    const name = playerNameInput.value.trim();
    if (!name) return alert('Enter your name');

    const userId = state.user?.id || Math.random().toString(36).substring(2);
    saveUser(userId, name);

    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const roundCount = parseInt(document.getElementById('round-count').value) || 3;

    const newRoom = {
        code: code,
        host_id: userId,
        status: 'LOBBY',
        settings: { totalRounds: roundCount, genrePool: GENRES },
        game_state: {
            currentRound: 1,
            currentGenre: null,
            currentSongIndex: 0,
            submissions: [], // { url, player_id, title }
            votes: {}, // { playerId: songIndex }
            readyPlayers: [], // [playerId]
            roundWinners: [], // [{ round, playerId, songIndex }]
            playerScores: {} // { playerId: score }
        },
        players: [{ id: userId, name: name, isHost: true }]
    };

    const { error } = await supabaseClient.from('rooms').insert(newRoom);
    if (error) return alert('Error creating room: ' + error.message);

    state.roomCode = code;
    state.isHost = true;
    subscribeToRoom(code);
}

async function joinRoom(code, name) {
    // 1. Fetch Room
    const { data: room, error } = await supabaseClient
        .from('rooms')
        .select('*')
        .eq('code', code)
        .single();

    if (error || !room) return alert('Room not found: ' + code);

    const userId = state.user?.id || Math.random().toString(36).substring(2);
    saveUser(userId, name);

    // 2. Check if already joined
    const existingPlayer = room.players.find(p => p.id === userId);
    if (!existingPlayer) {
        const updatedPlayers = [...room.players, { id: userId, name: name, isHost: false }];
        const { error: updateError } = await supabaseClient
            .from('rooms')
            .update({ players: updatedPlayers })
            .eq('code', code);

        if (updateError) return alert('Error joining room');
    }

    state.roomCode = code;
    state.isHost = (room.host_id === userId);
    subscribeToRoom(code);
}

function saveUser(id, name) {
    state.user = { id, name };
    localStorage.setItem('songwars_user', JSON.stringify(state.user));
}

function subscribeToRoom(code) {
    // Clean up old subscription
    if (state.channel) supabaseClient.removeChannel(state.channel);

    // Initial fetch to paint UI immediately
    fetchRoomState(code);

    // Realtime Subscription
    state.channel = supabaseClient
        .channel(`room:${code}`)
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'rooms',
            filter: `code=eq.${code}`
        }, payload => {
            syncState(payload.new);
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('Connected to room ' + code);
            }
        });

    // Update URL for easy sharing
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?room=' + code;
    window.history.pushState({ path: newUrl }, '', newUrl);
}

async function fetchRoomState(code) {
    const { data, error } = await supabaseClient.from('rooms').select('*').eq('code', code).single();
    if (data) syncState(data);
}

function syncState(room) {
    state.room = room; // Updates local copy
    const gameState = room.game_state;
    const settings = room.settings;

    // -- UI UPDATES --
    displayRoomCode.textContent = room.code;

    // Player List
    const list = document.getElementById('player-list');
    list.innerHTML = '';
    room.players.forEach(p => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${p.name} ${p.isHost ? '<small>(Host)</small>' : ''}</span><i data-lucide="user" size="16"></i>`;
        list.appendChild(li);
    });
    document.getElementById('player-count').textContent = room.players.length;
    lucide.createIcons();

    // Lobby Logic
    if (room.status === 'LOBBY') {
        showScreen('lobby-section');
        document.getElementById('waiting-msg').classList.toggle('hidden', state.isHost);
        document.getElementById('start-game-btn').classList.toggle('hidden', !state.isHost);
        document.getElementById('round-config').classList.toggle('hidden', !state.isHost);
        document.getElementById('genre-config').classList.toggle('hidden', !state.isHost);

        // Sync Genre Pool UI (Host Only)
        if (state.isHost) {
            const poolInput = document.getElementById('genre-pool-input');
            // Only update if not currently focused to avoid overwriting while typing
            if (document.activeElement !== poolInput) {
                poolInput.value = (room.settings.genrePool || GENRES).join(', ');
            }
        }
    }

    // Game Logic
    else if (room.status === 'GENRE_SPIN' && state.currentScreen !== 'genre-section') {
        showScreen('genre-section');
        document.getElementById('current-round-num').textContent = gameState.currentRound;
        document.getElementById('total-rounds-num').textContent = settings.totalRounds;

        // Reset Genre UI
        document.getElementById('genre-result').classList.add('hidden');
        document.getElementById('genre-display').textContent = '?';
        document.getElementById('host-genre-override').classList.toggle('hidden', !state.isHost);

        if (!state.genreSpun) {
            state.genreSpun = true;
            setTimeout(() => spinGenre(), 500);
        }
    }

    else if (room.status === 'SUBMITTING' && state.currentScreen !== 'submission-section') {
        showScreen('submission-section');
        // ... (rest of logic same)

        // Reset Form
        document.getElementById('youtube-url').value = '';
        document.getElementById('submit-song-btn').disabled = false;
        document.getElementById('submission-status').classList.add('hidden');

        // Genre Header
        const submissionCard = document.querySelector('#submission-section .glass-card');
        if (submissionCard && gameState.currentGenre) {
            let genreHint = submissionCard.querySelector('.genre-hint');
            if (!genreHint) {
                genreHint = document.createElement('p');
                genreHint.className = 'genre-hint';
                genreHint.style.cssText = 'color: var(--accent); font-weight: 600; margin-bottom: 1rem;';
                submissionCard.insertBefore(genreHint, submissionCard.querySelector('h2').nextSibling);
            }
            genreHint.textContent = `Theme: ${gameState.currentGenre}`;
        }
    }

    else if (room.status === 'PLAYING' && state.currentScreen !== 'playback-section') {
        showScreen('playback-section');
        const currentSong = gameState.submissions[gameState.currentSongIndex || 0];
        initYoutubePlayer(currentSong?.url);
    }

    else if (room.status === 'VOTING' && state.currentScreen !== 'voting-section') {
        if (player && player.stopVideo) player.stopVideo();
        showScreen('voting-section');
        renderVotingOptions(gameState.submissions);
    }

    else if (room.status === 'TIE_BREAKER' && state.currentScreen !== 'tie-breaker-section') {
        showScreen('tie-breaker-section');
        document.getElementById('tie-controls').classList.toggle('hidden', !state.isHost);

        // Reset spinner
        document.getElementById('tie-spinner').classList.remove('spinning');
        document.getElementById('tie-display').textContent = '?';

        if (gameState.tieBreaker?.spun && !state.tieSpun) {
            state.tieSpun = true;
            spinTieBreaker(gameState.tieBreaker.tiedIndices, true); // Auto-spin for non-hosts if already spun? 
            // Actually, simplified: Host clicks spin -> We assume everyone sees it locally or we sync the "spinning" state?
            // For simplicity, let's just let Host click it, and we might not sync the animation perfectly for everyone else unless we add a "SPINNING_TIE" status.
            // Better approach: Host determines winner immediately but with a delay, and we show animation?
            // Let's stick to: Host clicks -> Updates state -> Everyone sees result. 
            // To make it fun for everyone, we can have a "TIE_SPINNING" status? 
            // Or just let Host control it and transition to results. 
            // Let's implement local spin on button click for host, then update.
        }
    }

    else if (room.status === 'RESULTS' && state.currentScreen !== 'results-section') {
        showScreen('results-section');
        renderWinner(room);
    }

    // Ongoing Updates (Ready counts, Song index changes)
    if (room.status === 'PLAYING') {
        updateReadyUI(gameState, room.players.length);

        // Sync Song
        const currentIndex = gameState.currentSongIndex || 0;
        if (state.lastSongIndex !== currentIndex) {
            state.lastSongIndex = currentIndex;
            const currentSong = gameState.submissions[currentIndex];
            if (player && player.loadVideoById && currentSong) {
                const videoId = extractVideoId(currentSong.url);
                if (videoId) player.loadVideoById(videoId);
            }
        }
    }
}


// --- ACTIONS (Async Supabase Updates) ---

const resetBtn = document.getElementById('reset-db-btn');
if (resetBtn) resetBtn.addEventListener('click', async () => {
    if (!confirm('This will wipe ALL rooms and data. Are you sure?')) return;

    // Clear LocalStorage
    localStorage.clear();

    // Delete all rooms (using a filter that matches everything)
    const { error } = await supabaseClient
        .from('rooms')
        .delete()
        .neq('code', '______');

    if (error) {
        alert('Error resetting: ' + error.message);
    } else {
        alert('Data reset! Reloading...');
        // Reload without query params to clean state
        window.location.href = window.location.pathname;
    }
});

const createBtn = document.getElementById('create-room-btn');
if (createBtn) createBtn.addEventListener('click', createRoom);

const joinBtn = document.getElementById('join-room-btn');
if (joinBtn) {
    joinBtn.addEventListener('click', () => {
        if (!playerNameInput.value.trim()) return alert('Enter your name');
        document.querySelector('.input-group').classList.add('hidden');
        document.getElementById('join-input-group').classList.remove('hidden');
    });
}

const submitJoinBtn = document.getElementById('submit-join-btn');
if (submitJoinBtn) {
    submitJoinBtn.addEventListener('click', () => {
        const name = playerNameInput.value.trim();
        const code = roomCodeInput.value.trim().toUpperCase();
        joinRoom(code, name);
    });
}

const startGameBtn = document.getElementById('start-game-btn');
if (startGameBtn) {
    startGameBtn.addEventListener('click', async () => {
        console.log('Start Game clicked. Current state:', state);
        if (!state.room) {
            console.error('No room state found!');
            return;
        }
        state.genreSpun = false;
        const { error } = await supabaseClient.from('rooms').update({ status: 'GENRE_SPIN' }).eq('code', state.roomCode);
        if (error) {
            console.error('Error starting game:', error);
            alert('Failed to start game: ' + error.message);
        } else {
            console.log('Game started successfully (GENRE_SPIN)');
        }
    });
}

// Genre Logic
function spinGenre() {
    const spinner = document.getElementById('genre-spinner');
    const display = document.getElementById('genre-display');
    const resultDiv = document.getElementById('genre-result');
    const manualDiv = document.getElementById('host-genre-override');

    if (!state.room) return;

    // Use room's genre pool or default
    const pool = state.room.settings.genrePool || GENRES;
    const selectedGenre = pool[Math.floor(Math.random() * pool.length)] || 'Rock';

    spinner.classList.add('spinning');
    manualDiv.classList.add('hidden'); // Hide manual input during spin

    let counter = 0;
    const spinInterval = setInterval(() => {
        display.textContent = pool[counter % pool.length];
        counter++;
    }, 100);

    setTimeout(async () => {
        clearInterval(spinInterval);
        spinner.classList.remove('spinning');

        // Show locally first for smoothness
        display.textContent = selectedGenre;
        document.getElementById('selected-genre').textContent = selectedGenre;
        resultDiv.classList.remove('hidden');

        // Show Host Controls
        if (state.isHost) {
            document.getElementById('respin-btn').classList.remove('hidden');
            document.getElementById('host-genre-override').classList.remove('hidden');

            checkRespinForHost();

            // Host updates the DB
            const newState = { ...state.room.game_state, currentGenre: selectedGenre };
            await supabaseClient.from('rooms').update({
                game_state: newState
            }).eq('code', state.roomCode);
        }
    }, 2000);
}

function checkRespinForHost() {
    // Ensure respin button is visible only for host
    document.getElementById('respin-btn').classList.toggle('hidden', !state.isHost);
}

document.getElementById('respin-btn').addEventListener('click', () => {
    // Hide results and spin again locally
    document.getElementById('genre-result').classList.add('hidden');
    document.getElementById('host-genre-override').classList.add('hidden');
    spinGenre();
});

// Genre Configuration Listeners
document.getElementById('save-genres-btn').addEventListener('click', async () => {
    const rawinput = document.getElementById('genre-pool-input').value;
    const newPool = rawinput.split(',').map(s => s.trim()).filter(s => s.length > 0);

    if (newPool.length < 1) return alert('Please enter at least one genre');

    const newSettings = { ...state.room.settings, genrePool: newPool };

    // Optimistic update
    state.room.settings = newSettings;

    const { error } = await supabaseClient
        .from('rooms')
        .update({ settings: newSettings })
        .eq('code', state.roomCode);

    if (error) alert('Error saving genres');
    else alert('Genres saved!');
});

document.getElementById('reset-genres-btn').addEventListener('click', async () => {
    document.getElementById('genre-pool-input').value = GENRES.join(', ');
    const newSettings = { ...state.room.settings, genrePool: GENRES };

    state.room.settings = newSettings;

    await supabaseClient
        .from('rooms')
        .update({ settings: newSettings })
        .eq('code', state.roomCode);
});

document.getElementById('genre-csv-upload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const text = event.target.result;
        // Simple CSV parse: split by comma or newline
        const items = text.split(/[\n,]+/).map(s => s.trim()).filter(s => s.length > 0);

        if (items.length > 0) {
            document.getElementById('genre-pool-input').value = items.join(', ');
        } else {
            alert('No valid text found in file.');
        }
    };
    reader.readAsText(file);
});

// Manual Genre Override
document.getElementById('set-manual-genre-btn').addEventListener('click', async () => {
    const manualInput = document.getElementById('manual-genre-input');
    const genre = manualInput.value.trim();
    if (!genre) return alert('Enter a genre');

    // Update UI directly
    document.getElementById('genre-result').classList.remove('hidden');
    document.getElementById('selected-genre').textContent = genre;
    document.getElementById('host-genre-override').classList.add('hidden'); // Hide input after selecting

    // Update DB
    if (state.isHost) {
        const newState = { ...state.room.game_state, currentGenre: genre };
        await supabaseClient.from('rooms').update({
            game_state: newState
        }).eq('code', state.roomCode);
    }
});

document.getElementById('continue-to-submit-btn').addEventListener('click', async () => {
    if (state.isHost) {
        await supabaseClient.from('rooms').update({ status: 'SUBMITTING' }).eq('code', state.roomCode);
    }
});

document.getElementById('submit-song-btn').addEventListener('click', async () => {
    const url = document.getElementById('youtube-url').value.trim();
    if (!url) return alert('Enter a YouTube link');

    const submitBtn = document.getElementById('submit-song-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Fetching info...';

    // Fetch Title
    let songTitle = 'Mystery Song';
    try {
        const res = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
        const data = await res.json();
        if (data.title) songTitle = data.title;
    } catch (e) {
        console.warn('Failed to fetch title', e);
    }

    const { data: freshRoom } = await supabaseClient.from('rooms').select('game_state, players').eq('code', state.roomCode).single();
    if (!freshRoom) return;

    let subs = freshRoom.game_state.submissions || [];

    // Check if user already submitted - if so, update their submission
    const existingIndex = subs.findIndex(s => s.player_id === state.user.id);
    if (existingIndex !== -1) {
        // Update existing submission
        subs[existingIndex] = { url: url, player_id: state.user.id, title: songTitle };
    } else {
        // New submission
        subs.push({ url: url, player_id: state.user.id, title: songTitle });
    }

    // Only move to PLAYING when ALL players have submitted
    let newStatus = 'SUBMITTING';
    if (subs.length >= freshRoom.players.length) {
        newStatus = 'PLAYING';
    }

    const newGameState = { ...freshRoom.game_state, submissions: subs };

    await supabaseClient.from('rooms').update({
        game_state: newGameState,
        status: newStatus
    }).eq('code', state.roomCode);

    // Show status but keep button enabled for changing song
    document.getElementById('submission-status').classList.remove('hidden');

    // If not everyone has submitted yet, allow changing
    if (subs.length < freshRoom.players.length) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Change Song';
    } else {
        submitBtn.textContent = 'Submitted!';
    }
});

// Playing & Ready Logic
document.getElementById('ready-to-continue-btn').addEventListener('click', async () => {
    const { data: freshRoom } = await supabaseClient.from('rooms').select('game_state, players').eq('code', state.roomCode).single();
    if (!freshRoom) return;

    const gameState = freshRoom.game_state;
    const readyList = gameState.readyPlayers || [];

    if (!readyList.includes(state.user.id)) {
        readyList.push(state.user.id);
    }

    const updates = { readyPlayers: readyList };
    let statusUpdate = {};

    // Check if everyone is ready
    if (readyList.length >= freshRoom.players.length) {
        updates.readyPlayers = []; // Reset
        updates.currentSongIndex = (gameState.currentSongIndex || 0) + 1;

        if (updates.currentSongIndex >= gameState.submissions.length) {
            statusUpdate.status = 'VOTING';
            updates.currentSongIndex = 0;
        }
    }

    await supabaseClient.from('rooms').update({
        game_state: { ...gameState, ...updates },
        ...statusUpdate
    }).eq('code', state.roomCode);
});

function updateReadyUI(gameState, totalPlayers) {
    const readyBtn = document.getElementById('ready-to-continue-btn');
    const readyCountMsg = document.getElementById('ready-count-msg');
    const isReady = gameState.readyPlayers?.includes(state.user.id);

    if (readyBtn) {
        if (isReady) {
            readyBtn.disabled = true;
            readyBtn.textContent = '✓ Ready';
            readyCountMsg.style.display = 'block';
        } else {
            readyBtn.disabled = false;
            readyBtn.textContent = 'Ready to Continue';
        }
    }

    if (readyCountMsg) {
        document.getElementById('ready-count').textContent = gameState.readyPlayers?.length || 0;
        document.getElementById('total-players').textContent = totalPlayers;
    }

    document.getElementById('current-song-title').textContent = `Song ${(gameState.currentSongIndex || 0) + 1} of ${gameState.submissions.length}`;
}

// Voting Logic
function renderVotingOptions(submissions) {
    const container = document.getElementById('vote-options');
    container.innerHTML = '';

    // Sort logic? Or keep random? Random is better for anon.
    // Ensure we handle index correctly if we shuffle. For now, keep original index.

    submissions.forEach((s, i) => {
        const div = document.createElement('div');
        div.className = 'glass-card vote-item';

        const isMine = s.player_id === state.user.id;
        if (isMine) {
            div.classList.add('disabled');
            div.style.opacity = '0.5';
            div.style.cursor = 'not-allowed';
            div.innerHTML = `<i data-lucide="music"></i><span>${s.title || 'Song'} (You)</span>`;
        } else {
            div.innerHTML = `<i data-lucide="music"></i><span>${s.title || 'Song'}</span>`;
            div.onclick = () => {
                document.querySelectorAll('.vote-item').forEach(el => el.classList.remove('selected'));
                div.classList.add('selected');
                document.getElementById('submit-vote-btn').disabled = false;
            };
        }

        // Store index data for retrieval
        div.dataset.index = i;

        container.appendChild(div);
    });
    lucide.createIcons();
}

document.getElementById('submit-vote-btn').addEventListener('click', async () => {
    const selectedEl = document.querySelector('.vote-item.selected span');
    if (!selectedEl) return;

    const songIndex = parseInt(selectedEl.textContent.replace('Song ', '')) - 1;

    const { data: freshRoom } = await supabaseClient.from('rooms').select('game_state, players').eq('code', state.roomCode).single();
    const gameState = freshRoom.game_state;
    const votes = gameState.votes || {};

    votes[state.user.id] = songIndex;

    const updates = { votes: votes };
    let statusUpdate = {};

    if (Object.keys(votes).length >= freshRoom.players.length) {
        // All voted - Calculate Winner
        const voteCounts = {};
        Object.values(votes).forEach(idx => voteCounts[idx] = (voteCounts[idx] || 0) + 1);

        let maxVotes = 0;
        let winners = [];

        // First pass: find max
        for (const count of Object.values(voteCounts)) {
            if (count > maxVotes) maxVotes = count;
        }

        // Second pass: find all indices with max
        for (const [idx, count] of Object.entries(voteCounts)) {
            if (count === maxVotes) {
                winners.push(parseInt(idx));
            }
        }

        if (winners.length > 1) {
            // TIE DETECTED
            updates.tieBreaker = { tiedIndices: winners };
            statusUpdate.status = 'TIE_BREAKER';
        } else {
            // Single Winner
            const winnerSongIndex = winners[0];
            const winnerPlayerId = gameState.submissions[winnerSongIndex]?.player_id;
            const roundWinners = gameState.roundWinners || [];
            roundWinners.push({ round: gameState.currentRound, playerId: winnerPlayerId, songIndex: winnerSongIndex });

            const playerScores = gameState.playerScores || {};
            if (winnerPlayerId) playerScores[winnerPlayerId] = (playerScores[winnerPlayerId] || 0) + 1;

            updates.roundWinners = roundWinners;
            updates.playerScores = playerScores;
            statusUpdate.status = 'RESULTS';
        }
    }
    await supabaseClient.from('rooms').update({
        game_state: { ...gameState, ...updates },
        ...statusUpdate
    }).eq('code', state.roomCode);

    // Show confirmation
    const voteBtn = document.getElementById('submit-vote-btn');
    const voteStatus = document.getElementById('vote-status');
    if (voteBtn) {
        voteBtn.disabled = true;
        voteBtn.textContent = '✓ Voted!';
    }
    if (voteStatus) {
        voteStatus.classList.remove('hidden');
        document.getElementById('vote-count').textContent = Object.keys(votes).length;
        document.getElementById('vote-total').textContent = freshRoom.players.length;
    }
});

// Tie Breaker Logic
const spinTieBtn = document.getElementById('spin-tie-btn');
if (spinTieBtn) {
    spinTieBtn.addEventListener('click', () => {
        if (!state.room) return;
        const tiedIndices = state.room.game_state.tieBreaker.tiedIndices;
        spinTieBreaker(tiedIndices);
    });
}

function spinTieBreaker() {
    const spinner = document.getElementById('tie-spinner');
    const display = document.getElementById('tie-display');
    const btn = document.getElementById('spin-tie-btn');

    if (!btn || !spinner || !display) return;

    btn.disabled = true;
    spinner.classList.add('spinning');

    // Just use all players in the room
    const players = state.room.players;
    const playerNames = players.map(p => p.name);

    let counter = 0;
    const spinInterval = setInterval(() => {
        display.textContent = playerNames[counter % playerNames.length];
        counter++;
    }, 100);

    // Host calculates result after delay
    if (state.isHost) {
        setTimeout(async () => {
            clearInterval(spinInterval);
            spinner.classList.remove('spinning');

            // Pick random player
            const winnerPlayer = players[Math.floor(Math.random() * players.length)];
            display.textContent = winnerPlayer.name;

            // Commit Result
            const gameState = state.room.game_state;
            const winnerPlayerId = winnerPlayer.id;

            const roundWinners = gameState.roundWinners || [];
            roundWinners.push({ round: gameState.currentRound, playerId: winnerPlayerId, songIndex: 0 });

            const playerScores = gameState.playerScores || {};
            playerScores[winnerPlayerId] = (playerScores[winnerPlayerId] || 0) + 1;

            await new Promise(r => setTimeout(r, 1500)); // suspense pause

            await supabaseClient.from('rooms').update({
                game_state: {
                    ...gameState,
                    roundWinners,
                    playerScores,
                    tieBreaker: null
                },
                status: 'RESULTS'
            }).eq('code', state.roomCode);

            btn.disabled = false;
        }, 3000);
    }
}

// Results Logic
function renderWinner(room) {
    const gameState = room.game_state;
    const currentRoundWinner = gameState.roundWinners[gameState.roundWinners.length - 1];
    const winnerPlayer = room.players.find(p => p.id === currentRoundWinner?.playerId);
    const isLastRound = gameState.currentRound >= room.settings.totalRounds;

    const winnerReveal = document.getElementById('winner-reveal');
    const standingsBracket = document.getElementById('standings-bracket');
    const roundHistoryList = document.getElementById('round-history-list');
    const newRoundBtn = document.getElementById('new-round-btn');

    if (isLastRound) {
        document.querySelector('.winner-text').textContent = 'GAME OVER!';
        let overallWinnerId = null, maxWins = 0;
        for (const [pid, wins] of Object.entries(gameState.playerScores || {})) {
            if (wins > maxWins) { maxWins = wins; overallWinnerId = pid; }
        }
        const overallWinner = room.players.find(p => p.id === overallWinnerId);
        winnerReveal.innerHTML = `
            <h2 style="font-size: 2.5rem; margin-bottom: 1rem;">👑 ${overallWinner?.name || 'Unknown'}</h2>
            <p style="font-size: 1.2rem;">Champion with ${maxWins} round win(s)!</p>
        `;
    } else {
        document.querySelector('.winner-text').textContent = `ROUND ${gameState.currentRound} WINNER`;
        winnerReveal.innerHTML = `
            <h2 style="font-size: 2rem; margin-bottom: 1rem;">🎵 ${winnerPlayer?.name || 'Unknown'}</h2>
            <p>Wins this round!</p>
        `;
    }

    // Render Standings Bracket
    const sortedPlayers = room.players.map(p => ({
        ...p,
        wins: (gameState.playerScores || {})[p.id] || 0
    })).sort((a, b) => b.wins - a.wins);

    standingsBracket.innerHTML = '';
    sortedPlayers.forEach((p, idx) => {
        const rank = idx + 1;
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
        const div = document.createElement('div');
        div.className = 'bracket-row';
        div.innerHTML = `
            <span class="bracket-rank">${medal || '#' + rank}</span>
            <span class="bracket-name">${p.name}</span>
            <span class="bracket-score">${p.wins} win${p.wins !== 1 ? 's' : ''}</span>
            <div class="bracket-bar" style="width: ${(p.wins / (room.settings.totalRounds || 1)) * 100}%"></div>
        `;
        standingsBracket.appendChild(div);
    });

    // Render Round History
    roundHistoryList.innerHTML = '';
    (gameState.roundWinners || []).forEach(rw => {
        const player = room.players.find(p => p.id === rw.playerId);
        const li = document.createElement('li');
        li.innerHTML = `<span>Round ${rw.round}</span><span style="color: var(--accent);">${player?.name || 'Unknown'} 🏆</span>`;
        roundHistoryList.appendChild(li);
    });

    if (state.isHost) {
        newRoundBtn.textContent = isLastRound ? 'Play Again' : 'Next Round';
        newRoundBtn.classList.remove('hidden');
    }

    triggerConfetti();
}

document.getElementById('new-round-btn').addEventListener('click', async () => {
    if (!state.isHost) return;

    // Fetch fresh to be safe
    const { data: freshRoom } = await supabaseClient.from('rooms').select('*').eq('code', state.roomCode).single();
    const gameState = freshRoom.game_state;
    const isLastRound = gameState.currentRound >= freshRoom.settings.totalRounds;

    let updates = {};

    if (isLastRound) {
        // Reset Game
        updates = {
            currentRound: 1,
            roundWinners: [],
            playerScores: {},
            submissions: [],
            votes: {},
            readyPlayers: [],
            currentSongIndex: 0,
            currentGenre: null
        };
    } else {
        // Next Round
        updates = {
            currentRound: gameState.currentRound + 1,
            submissions: [],
            votes: {},
            readyPlayers: [],
            currentSongIndex: 0,
            currentGenre: null
        };
    }

    state.genreSpun = false;
    state.lastSongIndex = -1;

    await supabaseClient.from('rooms').update({
        game_state: { ...gameState, ...updates },
        status: 'GENRE_SPIN'
    }).eq('code', state.roomCode);
});

// --- YOUTUBE & UTILS --- (Unchanged)
let player;
function initYoutubePlayer(url) {
    if (player) return;
    const videoId = extractVideoId(url) || 'dQw4w9WgXcQ';

    // If script not loaded, load it (only once)
    if (!window.YT) {
        const tag = document.createElement('script');
        tag.src = "https://www.youtube.com/iframe_api";
        document.body.appendChild(tag);
        window.onYouTubeIframeAPIReady = () => createPlayer(videoId);
    } else {
        createPlayer(videoId);
    }
}

function createPlayer(videoId) {
    player = new YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        videoId: videoId,
        playerVars: { 'autoplay': 1, 'controls': 1, 'origin': window.location.origin },
        events: {
            'onReady': (e) => { e.target.playVideo(); updateProgress(); },
            'onError': onPlayerError
        }
    });
}

function onPlayerError(event) {
    console.error('YouTube Error:', event.data);
}

function extractVideoId(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

function updateProgress() {
    if (player && player.getCurrentTime) {
        const pct = (player.getCurrentTime() / player.getDuration()) * 100;
        document.getElementById('progress-bar').style.width = `${pct}%`;
        document.getElementById('current-time').textContent = formatTime(player.getCurrentTime());
        document.getElementById('total-time').textContent = formatTime(player.getDuration());
    }
    requestAnimationFrame(updateProgress);
}

function formatTime(s) {
    return Math.floor(s / 60) + ':' + Math.floor(s % 60).toString().padStart(2, '0');
}

function triggerConfetti() {
    for (let i = 0; i < 30; i++) {
        const c = document.createElement('div');
        c.style.cssText = `position:fixed;width:10px;height:10px;background:var(--accent);top:-10px;left:${Math.random() * 100}vw;z-index:99;border-radius:50%;`;
        document.body.appendChild(c);
        c.animate([{ top: '-10px' }, { top: '100vh', left: `${(Math.random() - 0.5) * 200}px` }], { duration: 2000 });
        setTimeout(() => c.remove(), 2000);
    }
}

// --- p5.js Visualizer ---
let visualizerSketch = function (p) {
    let particles = [];
    let wavePoints = [];
    const numWavePoints = 100;
    const numParticles = 50;
    let time = 0;

    p.setup = function () {
        const container = document.getElementById('visualizer-container');
        const canvas = p.createCanvas(p.windowWidth, p.windowHeight);
        canvas.parent('visualizer-container');
        p.noStroke();

        // Initialize wave points
        for (let i = 0; i < numWavePoints; i++) {
            wavePoints.push({
                x: (i / numWavePoints) * p.width,
                baseY: p.height / 2,
                offset: p.random(1000)
            });
        }

        // Initialize particles
        for (let i = 0; i < numParticles; i++) {
            particles.push({
                x: p.random(p.width),
                y: p.random(p.height),
                size: p.random(2, 6),
                speedX: p.random(-0.5, 0.5),
                speedY: p.random(-0.5, 0.5),
                alpha: p.random(50, 150)
            });
        }
    };

    p.draw = function () {
        p.clear();
        time += 0.02;

        // Simulate audio levels (since we can't access YouTube audio directly)
        const fakeLevel = (p.sin(time * 2) + 1) * 0.3 + 0.2;
        const fakeBass = (p.sin(time * 0.5) + 1) * 0.5;

        // Draw flowing wave
        p.noFill();
        p.strokeWeight(2);

        for (let layer = 0; layer < 3; layer++) {
            p.beginShape();
            const layerOffset = layer * 0.5;
            const alpha = 100 - layer * 30;

            // Gradient stroke effect
            if (layer === 0) {
                p.stroke(0, 212, 255, alpha);
            } else if (layer === 1) {
                p.stroke(123, 47, 247, alpha);
            } else {
                p.stroke(255, 100, 200, alpha);
            }

            for (let i = 0; i < numWavePoints; i++) {
                const wp = wavePoints[i];
                const waveHeight = p.sin(time + wp.offset + layerOffset) * (50 + fakeLevel * 100);
                const x = wp.x;
                const y = p.height * 0.7 + waveHeight;
                p.curveVertex(x, y);
            }
            p.endShape();
        }

        // Draw floating particles
        particles.forEach(particle => {
            // Move
            particle.x += particle.speedX + p.sin(time + particle.y * 0.01) * 0.5;
            particle.y += particle.speedY;

            // Wrap around
            if (particle.x < 0) particle.x = p.width;
            if (particle.x > p.width) particle.x = 0;
            if (particle.y < 0) particle.y = p.height;
            if (particle.y > p.height) particle.y = 0;

            // Pulse with "audio"
            const pulseSize = particle.size + fakeBass * 3;

            // Draw glow
            p.noStroke();
            p.fill(0, 212, 255, particle.alpha * 0.3);
            p.ellipse(particle.x, particle.y, pulseSize * 3);

            // Draw core
            p.fill(255, 255, 255, particle.alpha);
            p.ellipse(particle.x, particle.y, pulseSize);
        });

        // Draw center glow orb
        const orbSize = 100 + fakeBass * 50;
        const gradient = p.drawingContext.createRadialGradient(
            p.width / 2, p.height / 2, 0,
            p.width / 2, p.height / 2, orbSize
        );
        gradient.addColorStop(0, 'rgba(0, 212, 255, 0.2)');
        gradient.addColorStop(0.5, 'rgba(123, 47, 247, 0.1)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

        p.drawingContext.fillStyle = gradient;
        p.ellipse(p.width / 2, p.height / 2, orbSize * 4);
    };

    p.windowResized = function () {
        p.resizeCanvas(p.windowWidth, p.windowHeight);
        // Recalculate wave points
        for (let i = 0; i < wavePoints.length; i++) {
            wavePoints[i].x = (i / numWavePoints) * p.width;
        }
    };
};

// Start the visualizer
new p5(visualizerSketch);

init();
