// --- Processing Log ---
const processingLog = document.getElementById('processing-log');
function logStatus(msg) {
    if (!processingLog) return;
    processingLog.textContent += msg + '\n';
    processingLog.scrollTop = processingLog.scrollHeight;
}
// Removed duplicate geocodeBtn declaration and showGeocodeBtn function
// --- AI & Geocoding Integration ---
const FEATURE_LAYER_URL = "https://services5.arcgis.com/S5JQ6TlhA1BbeUBC/arcgis/rest/services/AIGeocoder/FeatureServer/0";
const SPATIAL_REF = { wkid: 4326 };

// Gemini (Google) API integration using REST fetch (no SDK required)
async function analyzeImageWithAI(base64Image, aiKey) {
    const prompt_text = `You are an expert OCR assistant trained specifically to interpret handwritten water/sewer connection permits.\nYou will be given an image of a permit filled out by applicants.\nYour task is to extract handwritten entries from known labeled sections of the form, which may vary slightly in position across permits.\nEach field is identified by printed text followed by a handwritten response on or near an underlined blank.\nWhen given an image, extract and return ONLY a JSON object with the following keys and rules (do not include any explanation or extra text):\n  • address: The handwritten address next to 'Location of Installation'. Append ' Marion Indiana 46952' to the result.\n  • date: The handwritten date next to the top-left 'Date:' label. Format it as MM-DD-YYYY.\n  • size: The first part of the handwritten value next to 'Size and Type of Service Line'. Convert to decimal inches (e.g., 3/4\" becomes 0.75, 1 1/2 becomes 1.5).\n  • material: The second part of the same field after the size. Interpret 'K' as 'copper', 'PVC' or 'poly' as 'PVC'. If no material is written, return null.\n  • notes: Capture any additional handwritten information near that section that does not belong to the other fields (such as 'behind curb' or hydrant direction), or return null if there are no notes.\nAssume handwriting may vary and values may be slightly misaligned. Only extract the fields listed above and return valid JSON.`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key=${encodeURIComponent(aiKey)}`;
    const body = {
        contents: [
            {
                parts: [
                    { text: prompt_text },
                    { inline_data: { mime_type: "image/jpeg", data: base64Image } }
                ]
            }
        ]
    };
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const data = await response.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    // Remove Markdown code block if present
    if (text.startsWith("```")) {
        text = text.split("```", 2)[1] || text;
        if (text.trim().startsWith("json")) {
            text = text.trim().slice(4);
        }
        text = text.trim();
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error("AI response could not be parsed as JSON: " + text);
    }
}

async function geocodeAddressAGOL(address, token) {
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&SingleLine=${encodeURIComponent(address)}&outFields=*&maxLocations=1&token=${encodeURIComponent(token)}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.candidates && data.candidates.length > 0) {
        const loc = data.candidates[0].location;
        return { x: loc.x, y: loc.y };
    }
    return null;
}

async function addFeatureToLayer(attributes, geometry, token) {
    const adds = [{ attributes, geometry }];
    const url = `${FEATURE_LAYER_URL}/addFeatures`;
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `f=json&token=${encodeURIComponent(token)}&features=${encodeURIComponent(JSON.stringify(adds))}`
    });
    return await resp.json();
}

// Helper: convert File/Blob to base64
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result.split(",")[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const signOutBtn = document.getElementById('sign-out-btn');

function showSignOut(show) {
    signOutBtn.style.display = show ? '' : 'none';
}

// --- ArcGIS Online sign-in logic ---
const checkBtn = document.getElementById('check-credentials-btn');
const aiKeyInput = document.getElementById('ai-key-input');
const checkAIButton = document.getElementById('check-ai-btn');
const geocodeBtn = document.getElementById('geocode-btn');

// State tracking for enabling Geocode button
let aiKeyIsValid = false;
let agolIsSignedIn = false;
let fileIsUploaded = false;

function updateGeocodeBtnVisibility() {
    if (aiKeyIsValid && agolIsSignedIn && fileIsUploaded) {
        geocodeBtn.style.display = '';
    } else {
        geocodeBtn.style.display = 'none';
    }
}

function showAICheckPill(text) {
    checkAIButton.textContent = text;
    checkAIButton.classList.add('ai-check-pill');
    checkAIButton.style.background = '#28a745';
    checkAIButton.style.color = '#fff';
    checkAIButton.style.fontWeight = 'bold';
    aiKeyIsValid = true;
    updateGeocodeBtnVisibility();
}
function showAICheckFail() {
    checkAIButton.textContent = 'Try Again Check Key';
    checkAIButton.classList.remove('ai-check-pill');
    checkAIButton.style.background = '';
    checkAIButton.style.color = '';
    checkAIButton.style.fontWeight = '';
    aiKeyIsValid = false;
    updateGeocodeBtnVisibility();
}
function resetAICheckPill() {
    checkAIButton.textContent = 'Check AI';
    checkAIButton.classList.remove('ai-check-pill');
    checkAIButton.style.background = '';
    checkAIButton.style.color = '';
    checkAIButton.style.fontWeight = '';
    aiKeyIsValid = false;
    updateGeocodeBtnVisibility();
}

checkAIButton.addEventListener('click', async function() {
    resetAICheckPill();
    const aiKey = aiKeyInput.value.trim();
    if (!aiKey) {
        showAICheckFail();
        return;
    }
    checkAIButton.textContent = 'Checking...';
    checkAIButton.classList.remove('ai-check-pill');
    checkAIButton.style.background = '';
    checkAIButton.style.color = '';
    checkAIButton.style.fontWeight = '';
    checkAIButton.disabled = true;
    try {
        // Use Gemini API with a silly prompt
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key=${encodeURIComponent(aiKey)}`;
        const body = {
            contents: [
                { parts: [ { text: 'Reply with three silly words to prove you are alive.' } ] }
            ]
        };
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        // Check for error or missing/empty candidates
        if (data.error || !data.candidates || !Array.isArray(data.candidates) || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0] || !data.candidates[0].content.parts[0].text) {
            showAICheckFail();
        } else {
            let text = data.candidates[0].content.parts[0].text.trim();
            if (text.startsWith('```')) {
                text = text.split('```', 2)[1] || text;
                text = text.trim();
            }
            if (text.length > 40) text = text.slice(0, 40) + '...';
            showAICheckPill(text);
        }
    } catch (e) {
        showAICheckFail();
    } finally {
        checkAIButton.disabled = false;
    }
});

const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');


function setButtonState(signedIn, fullName) {
    agolIsSignedIn = !!signedIn;
    if (signedIn) {
        checkBtn.textContent = 'Signed into AGOL' + (fullName ? ` as ${fullName}` : '');
        checkBtn.style.background = '#28a745';
        checkBtn.style.color = '#fff';
        checkBtn.disabled = true;
        showSignOut(true);
    } else {
        // If last attempt failed, show retry text, else default
        if (setButtonState.lastTried && !setButtonState.lastSuccess) {
            checkBtn.textContent = 'Try Sign In Again';
        } else {
            checkBtn.textContent = 'Check Credentials';
        }
        checkBtn.style.background = '';
        checkBtn.style.color = '';
        checkBtn.disabled = false;
        showSignOut(false);
    }
    updateGeocodeBtnVisibility();
}
geocodeBtn.addEventListener('click', async function() {
    geocodeBtn.textContent = 'Working';
    geocodeBtn.disabled = true;
    processingLog.textContent = '';
    logStatus('--- Geocoding Process Started ---');

    // Find uploaded file(s) from fileInfo (UI) and process
    // We'll assume only one file for now (single image or zip)
    // You may want to adapt this for multiple files in a zip
    let fileList = [];
    // Try to get file name(s) from fileInfo
    const fileInfoList = fileInfo.querySelector('ul');
    if (fileInfoList) {
        fileList = Array.from(fileInfoList.querySelectorAll('li')).map(li => li.textContent);
    }
    if (fileList.length === 0) {
        logStatus('No files to process.');
        geocodeBtn.textContent = 'Complete';
        geocodeBtn.disabled = false;
        return;
    }

    // For each file, actually process and log each step
    // We'll assume the user uploaded a single image file (not zip) for now
    // You can expand this to handle zip/multiple files as needed
    const aiKey = aiKeyInput.value.trim();
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    let token = null;
    // Get AGOL token from IdentityManager if available
    if (window.require) {
        try {
            await new Promise((resolve, reject) => {
                window.require(["esri/identity/IdentityManager"], function(IdentityManager) {
                    const creds = IdentityManager.findCredential("https://www.arcgis.com/sharing/rest");
                    if (creds && creds.token) {
                        token = creds.token;
                        resolve();
                    } else {
                        reject("No AGOL token found");
                    }
                });
            });
        } catch (e) {
            logStatus('  Error: Could not get AGOL token.');
            geocodeBtn.textContent = 'Complete';
            geocodeBtn.disabled = false;
            return;
        }
    }
    for (const fname of fileList) {
        logStatus(`Processing: ${fname}`);
        try {
            // Find the File object from the input (drag/drop)
            let fileObj = null;
            // Try to find the file in the drop zone's FileList
            if (window.lastDroppedFiles && window.lastDroppedFiles.length) {
                fileObj = Array.from(window.lastDroppedFiles).find(f => f.name === fname);
            }
            if (!fileObj) {
                logStatus(`  Error: File object for ${fname} not found.`);
                continue;
            }
            // Convert to base64
            logStatus('  Reading image...');
            const base64 = await fileToBase64(fileObj);
            // Analyze with Gemini
            logStatus('  Sending to AI...');
            let aiResult = null;
            try {
                aiResult = await analyzeImageWithAI(base64, aiKey);
            } catch (e) {
                logStatus('  Error: AI response could not be parsed.');
                continue;
            }
            const address = aiResult.address;
            logStatus(`  Found address: ${address || '[none]'}`);
            if (!address) {
                logStatus(`  No address found; skipping ${fname}`);
                continue;
            }
            // Geocode
            logStatus('  Geocoding address...');
            let loc = null;
            try {
                loc = await geocodeAddressAGOL(address, token);
            } catch (e) {
                logStatus(`  Error: Geocoding failed for ${address}`);
                continue;
            }
            if (!loc) {
                logStatus(`  Geocode failed for: ${address}`);
                continue;
            }
            // Prepare attributes & geometry
            const attrs = {
                address: address,
                installdate: aiResult.date,
                diameter: aiResult.size,
                material: aiResult.material,
                notes: aiResult.notes
            };
            const geom = { x: loc.x, y: loc.y, spatialReference: SPATIAL_REF };
            // Add to feature layer
            logStatus('  Adding feature to layer...');
            let addResp = null;
            try {
                addResp = await addFeatureToLayer(attrs, geom, token);
            } catch (e) {
                logStatus(`  Error: Failed to add feature for ${fname}`);
                continue;
            }
            if (addResp && addResp.addResults && addResp.addResults[0] && addResp.addResults[0].success) {
                logStatus(`  Added feature for ${fname}`);
            } else {
                logStatus(`  Error: Feature not added for ${fname}`);
            }
        } catch (e) {
            logStatus(`  Error processing ${fname}: ${e}`);
        }
    }
    logStatus('--- Geocoding Complete ---');
    geocodeBtn.textContent = 'Complete';
    geocodeBtn.disabled = false;
});

// Track last sign-in attempt for button text
setButtonState.lastTried = false;
setButtonState.lastSuccess = false;
signOutBtn.addEventListener('click', function() {
    require(["esri/identity/IdentityManager"], function(IdentityManager) {
        IdentityManager.destroyCredentials();
        setButtonState(false, '');
    });
});

checkBtn.addEventListener('click', function() {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
        alert('Please enter both username and password.');
        return;
    }
    checkBtn.textContent = 'Signing in...';
    checkBtn.disabled = true;
    setButtonState.lastTried = true;
    require(["esri/identity/IdentityManager", "esri/request"], function(IdentityManager, esriRequest) {
        IdentityManager.registerToken({
            server: "https://www.arcgis.com/sharing/rest",
            userId: username,
            token: null,
            expires: 0
        });
        esriRequest(
            "https://www.arcgis.com/sharing/rest/generateToken",
            {
                method: "post",
                query: {
                    username: username,
                    password: password,
                    referer: window.location.origin,
                    f: "json"
                },
                responseType: "json"
            }
        ).then(function(response) {
            if (response.data && response.data.token) {
                setButtonState.lastSuccess = true;
                IdentityManager.registerToken({
                    server: "https://www.arcgis.com/sharing/rest",
                    userId: username,
                    token: response.data.token,
                    expires: response.data.expires
                });
                // Fetch user info to get first name
                esriRequest(
                    "https://www.arcgis.com/sharing/rest/community/self",
                    {
                        query: { f: "json", token: response.data.token },
                        responseType: "json"
                    }
                ).then(function(userResp) {
                    let fullName = '';
                    if (userResp.data && userResp.data.fullName) {
                        fullName = userResp.data.fullName;
                    }
                    setButtonState(true, fullName);
                }).catch(function() {
                    setButtonState(true, '');
                });
            } else {
                setButtonState.lastSuccess = false;
                setButtonState(false);
                alert('Sign in failed. Please check your credentials.');
            }
        }).catch(function() {
            setButtonState.lastSuccess = false;
            setButtonState(false);
            alert('Sign in failed. Please check your credentials.');
        });
    });
});
// --- Animated Orbs Background ---
const canvas = document.getElementById('orbs-bg');
const ctx = canvas.getContext('2d');
let orbs = [];
const ORB_COUNT = 70;
const ORB_MIN_RADIUS = 1.5;
const ORB_MAX_RADIUS = 4.5;
const ORB_MIN_SPEED = 0.2;
const ORB_MAX_SPEED = 0.7;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function randomBetween(a, b) {
    return a + Math.random() * (b - a);
}

function createOrbs() {
    orbs = [];
    for (let i = 0; i < ORB_COUNT; i++) {
        const radius = randomBetween(ORB_MIN_RADIUS, ORB_MAX_RADIUS);
        const x = randomBetween(radius, canvas.width - radius);
        const y = randomBetween(radius, canvas.height - radius);
        const angle = Math.random() * 2 * Math.PI;
        const speed = randomBetween(ORB_MIN_SPEED, ORB_MAX_SPEED);
        orbs.push({
            x, y, radius,
            dx: Math.cos(angle) * speed,
            dy: Math.sin(angle) * speed,
            alpha: randomBetween(0.3, 0.7)
        });
    }
}

function animateOrbs() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const orb of orbs) {
        // Move orb
        orb.x += orb.dx;
        orb.y += orb.dy;
        // Bounce off edges
        if (orb.x - orb.radius < 0 || orb.x + orb.radius > canvas.width) {
            orb.dx *= -1;
        }
        if (orb.y - orb.radius < 0 || orb.y + orb.radius > canvas.height) {
            orb.dy *= -1;
        }
        // Draw orb
        ctx.save();
        ctx.globalAlpha = orb.alpha;
        ctx.beginPath();
        ctx.arc(orb.x, orb.y, orb.radius, 0, 2 * Math.PI);
        ctx.fillStyle = '#aaa';
        ctx.shadowColor = '#fff';
        ctx.shadowBlur = 6;
        ctx.fill();
        ctx.restore();
    }
    requestAnimationFrame(animateOrbs);
}

createOrbs();
animateOrbs();
window.addEventListener('resize', () => {
    resizeCanvas();
    createOrbs();
});
// --- End Animated Orbs Background ---

const dropZone = document.getElementById('drop-zone');
const fileInfo = document.getElementById('file-info');
const fileInfoP = fileInfo.querySelector('p');

const IMAGE_EXTENSIONS = [
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.svg'
];

function isImageFile(name) {
    const lower = name.toLowerCase();
    return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// Prevent default drag behaviors
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
    document.body.addEventListener(eventName, preventDefaults, false); // Prevent browser opening file
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

// Highlight drop zone when item is dragged over it
['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, highlight, false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, unhighlight, false);
});

function highlight(e) {
    dropZone.classList.add('dragover');
}

function unhighlight(e) {
    dropZone.classList.remove('dragover');
}

// Handle dropped files
dropZone.addEventListener('drop', handleDrop, false);

// Store dropped files globally for geocoding
window.lastDroppedFiles = [];

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;

    window.lastDroppedFiles = [];

    if (files.length > 0) {
        const file = files[0];
        if (file.size > MAX_FILE_SIZE) {
            fileInfo.innerHTML = '<p>File is too large. Maximum allowed size is 100MB.</p>';
            fileIsUploaded = false;
            updateGeocodeBtnVisibility();
            return;
        }
        if (file.type === 'application/zip' || file.name.toLowerCase().endsWith('.zip')) {
            // Handle zip file
            handleZipFile(file);
        } else if (file.type.startsWith('image/') || isImageFile(file.name)) {
            // Single image file
            fileInfo.innerHTML = `<p>Received 1 image file:</p><ul><li>${file.name}</li></ul>`;
            window.lastDroppedFiles = [file];
            fileIsUploaded = true;
            updateGeocodeBtnVisibility();
        } else {
            fileInfo.innerHTML = '<p>Please drop an image file or a zip containing images.</p>';
            fileIsUploaded = false;
            updateGeocodeBtnVisibility();
        }
    } else {
        fileInfo.innerHTML = '<p>No file dropped.</p>';
        fileIsUploaded = false;
        updateGeocodeBtnVisibility();
    }
}

function handleZipFile(file) {
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const zip = await JSZip.loadAsync(e.target.result);
            const imageFiles = [];
            const fileBlobs = [];
            const promises = [];
            zip.forEach((relativePath, zipEntry) => {
                if (!zipEntry.dir && isImageFile(zipEntry.name)) {
                    imageFiles.push(zipEntry.name);
                    promises.push(zipEntry.async('blob').then(blob => {
                        // Create a File object if possible, else fallback to Blob with name
                        let f;
                        try {
                            f = new File([blob], zipEntry.name, { type: blob.type });
                        } catch {
                            f = blob;
                            f.name = zipEntry.name;
                        }
                        fileBlobs.push(f);
                    }));
                }
            });
            await Promise.all(promises);
            if (imageFiles.length > 0) {
                fileInfo.innerHTML = `<p>Received ${imageFiles.length} image file${imageFiles.length > 1 ? 's' : ''}:</p><ul>${imageFiles.map(name => `<li>${name}</li>`).join('')}</ul>`;
                window.lastDroppedFiles = fileBlobs;
                fileIsUploaded = true;
            } else {
                fileInfo.innerHTML = '<p>No image files found in the zip.</p>';
                window.lastDroppedFiles = [];
                fileIsUploaded = false;
            }
            updateGeocodeBtnVisibility();
        } catch (err) {
            fileInfo.innerHTML = '<p>Error reading zip file.</p>';
            window.lastDroppedFiles = [];
            fileIsUploaded = false;
            updateGeocodeBtnVisibility();
        }
    };
    reader.readAsArrayBuffer(file);
}
