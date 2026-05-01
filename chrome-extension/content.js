// Cloudbeds is a Single Page Application (SPA), so we must observe mutations to see when a reservation opens.

let injectionAttempted = false;

function injectTabletButton() {
    // Look for a known Cloudbeds element in the reservation slide-out or page
    // Often reservation IDs are in the URL hash like: #/reservations/123456
    const hash = window.location.hash;
    const resMatch = hash.match(/\/reservations\/(\d+)/) || hash.match(/\/reservation\/(\d+)/);
    
    if (!resMatch) {
       // We are not on a reservation page
       removeTabletButton();
       return;
    }

    const reservationId = resMatch[1];

    let alphaId = null;
    const titleMatch = document.title.match(/([A-Z0-9]{8,12})/);
    if (titleMatch && /[A-Z]/.test(titleMatch[1]) && /[0-9]/.test(titleMatch[1])) {
        alphaId = titleMatch[1];
    } else {
        const bodyMatch = document.body.innerText.match(/\b([A-Z0-9]{9,12})\b/);
        if (bodyMatch && /[A-Z]/.test(bodyMatch[1]) && /[0-9]/.test(bodyMatch[1])) {
            alphaId = bodyMatch[1];
        }
    }

    if (document.getElementById('cloudbeds-kiosk-push-container')) {
        // Already injected, just update the dataset ID in case URL changed
        document.getElementById('cloudbeds-kiosk-push-container').dataset.resId = reservationId;
        if (alphaId) document.getElementById('cloudbeds-kiosk-push-container').dataset.alphaId = alphaId;
        return;
    }

    // Create the container
    const container = document.createElement("div");
    container.id = "cloudbeds-kiosk-push-container";
    container.dataset.resId = reservationId;
    if (alphaId) container.dataset.alphaId = alphaId;

    Object.assign(container.style, {
        position: 'fixed',
        bottom: '30px',
        right: '30px',
        zIndex: '999999',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '10px'
    });

    // Create the main toggle button
    const mainBtn = document.createElement("button");
    mainBtn.innerText = "📲 Push to Tablet";
    
    const btnStyle = {
        backgroundColor: '#007BFF',
        color: '#FFFFFF',
        border: 'none',
        borderRadius: '50px',
        padding: '12px 24px',
        fontSize: '14px',
        fontWeight: 'bold',
        boxShadow: '0px 4px 6px rgba(0,0,0,0.2)',
        cursor: 'pointer',
        transition: 'all 0.3s ease'
    };
    Object.assign(mainBtn.style, btnStyle);

    mainBtn.addEventListener('mouseenter', () => { mainBtn.style.backgroundColor = '#0056b3'; });
    mainBtn.addEventListener('mouseleave', () => { mainBtn.style.backgroundColor = '#007BFF'; });

    // Create the expanded options menu
    const optionsMenu = document.createElement("div");
    Object.assign(optionsMenu.style, {
        display: 'none',
        flexDirection: 'column',
        gap: '5px',
        backgroundColor: 'white',
        padding: '10px',
        borderRadius: '10px',
        boxShadow: '0px 4px 12px rgba(0,0,0,0.15)'
    });

    const createOption = (kioskId, label) => {
        const opt = document.createElement("button");
        opt.innerText = label;
        Object.assign(opt.style, {
            backgroundColor: '#f8f9fa',
            color: '#333',
            border: '1px solid #ddd',
            borderRadius: '5px',
            padding: '8px 16px',
            fontSize: '14px',
            cursor: 'pointer',
            fontWeight: 'bold',
            transition: 'background 0.2s'
        });
        opt.addEventListener('mouseenter', () => { opt.style.backgroundColor = '#e2e6ea'; });
        opt.addEventListener('mouseleave', () => { opt.style.backgroundColor = '#f8f9fa'; });
        
        opt.addEventListener('click', () => {
            const id = container.dataset.resId;
            const aId = container.dataset.alphaId || null;
            const originalText = mainBtn.innerText;
            if (!id) return;

            mainBtn.innerText = `Pushing to Kiosk ${kioskId}...`;
            optionsMenu.style.display = 'none';
            
            fetch('https://kiosk.gatewayparkhotel.com/api/kiosk/push', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reservationId: id, alphaId: aId, kioskId: kioskId })
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    mainBtn.innerText = `✅ Kiosk ${kioskId} Synced!`;
                    mainBtn.style.backgroundColor = '#28a745';
                    setTimeout(() => {
                        mainBtn.innerText = "📲 Push to Tablet";
                        mainBtn.style.backgroundColor = '#007BFF';
                    }, 3000);
                } else {
                    alert("Failed to sync to tablet: " + data.error);
                    mainBtn.innerText = "📲 Push to Tablet";
                }
            })
            .catch(err => {
                alert("Local Autonomy server unreachable. Make sure node server.js is running.");
                mainBtn.innerText = "📲 Push to Tablet";
            });
        });
        return opt;
    };

    optionsMenu.appendChild(createOption('1', 'Kiosk 1 (Terminal 1)'));
    optionsMenu.appendChild(createOption('2', 'Kiosk 2 (Terminal 2)'));

    // Toggle menu on click
    mainBtn.addEventListener('click', () => {
        if (optionsMenu.style.display === 'none') {
            optionsMenu.style.display = 'flex';
        } else {
            optionsMenu.style.display = 'none';
        }
    });

    container.appendChild(optionsMenu);
    container.appendChild(mainBtn);
    document.body.appendChild(container);
}

function removeTabletButton() {
    const container = document.getElementById('cloudbeds-kiosk-push-container');
    if (container) container.remove();
}

// Observe URL changes natively inside the Cloudbeds SPA
let lastUrl = location.href; 
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    injectTabletButton();
  }
}).observe(document, {subtree: true, childList: true});

// Initial injection try
setInterval(injectTabletButton, 2000);
