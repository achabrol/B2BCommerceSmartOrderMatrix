import { LightningElement, track, api } from 'lwc';
import askEinstein from '@salesforce/apex/B2BCommerceOrderMatrixController.askEinstein';
import analyzeFileWithEinstein from '@salesforce/apex/B2BCommerceOrderMatrixController.analyzeFileWithEinstein';
import explainAdjustmentsWithEinstein from '@salesforce/apex/B2BCommerceOrderMatrixController.explainAdjustmentsWithEinstein';
import detectLanguage from '@salesforce/apex/B2BCommerceOrderMatrixController.detectLanguage'; // AJOUT IMPORT
import communityBasePath from '@salesforce/community/basePath';

/**
 * @description Assistant virtuel B2B.
 * Gère le chat UI et communique avec le contrôleur Apex pour envoyer le contexte produit à Einstein.
 * Transforme les réponses JSON de l'IA en cartes produits visuelles et événements "addproduct".
 * Gère également l'upload de fichiers (CSV/TXT) pour extraction automatique.
 */
export default class B2bAiAssistant extends LightningElement {
    
    @api products = [];
    // --- NOUVEAUX ATTRIBUTS POUR LES COMMANDES ---
    @api pastOrders = [];
    @api orderItems = {};

    // --- GESTION UTILISATEUR & LANGUE ---
    _userName;
    @track userLanguage; // Stocke la langue détectée
    
    @api
    get userName() { return this._userName; }
    set userName(value) {
        this._userName = value;
        this.updateWelcomeMessage();
    }
    
    /**
     * @description Met à jour le message de bienvenue si le nom de l'utilisateur est disponible.
     */
    updateWelcomeMessage() {
        if (this._userName && this.messages.length > 0 && this.messages[0].id === 'welcome') {
            this.messages[0].text = `Hello ${this._userName}! I'm your B2B Sales Assistant. How can I help you today? You can also upload a CSV or Text file with a list of products.`;
            this.messages = [...this.messages];
        }
    }
    // -----------------------------------

    // --- MEMOIRE ---
    lastShownItems = []; 
    // ---------------

    @track messages = [
        { 
            id: 'welcome', 
            text: "Hello! I'm your B2B Sales Assistant. How can I help you today? You can also upload a CSV or Text file with a list of products.", 
            isAi: true,
            wrapperClass: 'message-wrapper left', 
            bubbleClass: 'chat-bubble left' 
        }
    ];
    @track userInput = '';
    @track isTyping = false;
    
    conversationContext = ''; 

    /**
     * @description Capture la saisie de l'utilisateur dans l'input text.
     * @param event L'événement de changement standard.
     */
    handleInputChange(event) { this.userInput = event.target.value; }

    /**
     * @description Gère l'appui sur la touche Entrée pour envoyer le message.
     * @param event L'événement clavier.
     */
    handleKeyUp(event) { if (event.key === 'Enter') this.handleSend(); }

    // --- LOGIQUE DE VALIDATION QUANTITÉ ---

    /**
     * @description Calcule la quantité valide à ajouter en fonction des règles Min/Max/Incrément et Stock.
     * Retourne la quantité ajustée et la raison si ajustement.
     */
    calculateValidQuantity(product, requestedQty) {
        let qty = parseFloat(requestedQty);
        let reasons = [];
        
        // 1. Récupération des contraintes
        const min = product.minQty ? parseFloat(product.minQty) : 1;
        const max = product.maxQty ? parseFloat(product.maxQty) : 999999;
        const inc = product.increment ? parseFloat(product.increment) : 1;
        
        // Stock calculé
        const isInfiniteStock = (product.stock === undefined || product.stock === null || product.stock === 'null');
        const physicalStock = isInfiniteStock ? 999999 : parseFloat(product.stock);
        const inCart = product.cartQty ? parseFloat(product.cartQty) : 0;
        const selected = product.qtyValue ? parseFloat(product.qtyValue) : 0;
        const availableStock = Math.max(0, physicalStock - inCart - selected);

        // Détection de l'intention "Tout le stock" venant de l'IA (valeur > 9 millions)
        const isMaxRequest = qty > 9000000; 
        let initialQty = qty;

        // 2. Application des règles
        // Règle Min
        if (qty < min) {
            qty = min;
            reasons.push(`Minimum quantity is ${min}`);
        }

        // Règle Incrément
        if (inc > 1) {
            let remainder = qty % inc;
            if (remainder !== 0) {
                qty = Math.ceil(qty / inc) * inc;
                reasons.push(`Adjusted to multiple of ${inc}`);
            }
        }

        // Règle Max (Config Product)
        if (qty > max) {
            qty = max;
            reasons.push(`Maximum allowed per order is ${max}`);
        }

        // Règle Stock (Physique)
        if (qty > availableStock) {
            qty = availableStock;
            if (isMaxRequest) {
                // Si c'était une demande "Max", on change la raison pour que ce soit positif
                reasons.push(`Added all available stock (${availableStock})`);
            } else {
                reasons.push(`Limited by available stock (${availableStock} remaining)`);
            }
        }

        // Calcul ajustement
        const isAdjusted = (qty !== initialQty) || reasons.length > 0;

        if (isAdjusted) {
            console.warn(`⚠️ [ADJUSTMENT] ${product.name}: Requested ${initialQty} -> Final ${qty}. Reasons:`, reasons);
        } else {
            console.log(`✅ [VALID] ${product.name}: Requested ${initialQty} -> OK.`);
        }

        return {
            finalQty: qty,
            isAdjusted: isAdjusted,
            reasons: reasons
        };
    }
    
    /**
     * @description Formate les commandes et leurs items en une chaîne JSON simplifiée pour l'IA.
     * Limite aux 10 dernières commandes pour optimiser la taille du contexte.
     */
    formatOrdersForContext() {
        if (!this.pastOrders || this.pastOrders.length === 0) {
            return 'No order history available.';
        }

        // On prend les 10 dernières commandes max
        const recentOrders = this.pastOrders.slice(0, 10);
        
        const simplifiedOrders = recentOrders.map(order => {
            // Récupération des items depuis le cache parent
            // CORRECTION: Utilisation de order.id (venant de l'Apex) au lieu de orderSummaryId qui n'existe pas
            const orderId = order.id || order.orderSummaryId;
            const items = this.orderItems && this.orderItems[orderId] 
                ? this.orderItems[orderId] 
                : []; 
            
            // Essai d'enrichissement des items avec le SKU/Nom si disponible dans this.products (Catalogue courant)
            const enrichedItems = items.map(it => {
                const prodInCat = this.products.find(p => p.id === it.productId);
                return {
                    sku: prodInCat ? (prodInCat.sku || prodInCat.StockKeepingUnit) : it.productId,
                    qty: it.quantity,
                    name: prodInCat ? prodInCat.name : 'Unknown Product'
                };
            });

            return {
                OrderNumber: order.orderNumber,
                Status: order.status,
                Date: order.orderedDate,
                Total: order.grandTotalAmount,
                Currency: order.currencyIsoCode,
                Items: enrichedItems
            };
        });

        // AJOUT: Debug Log pour vérifier la structure dans la console Chrome
        console.log('📢 [DEBUG CONTEXT] Orders for AI:', JSON.parse(JSON.stringify(simplifiedOrders)));

        return JSON.stringify(simplifiedOrders);
    }

    // --- GESTION FICHIERS ---

    /**
     * @description Déclenche le clic sur l'input file caché.
     */
    triggerFileUpload() {
        const fileInput = this.template.querySelector('.file-input-hidden');
        if (fileInput) fileInput.click();
    }

    /**
     * @description Gère la sélection du fichier et lance la lecture.
     */
    handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        this.addMessage(`Analyzing file: ${file.name}...`, false);
        this.isTyping = true;
        this.scrollToBottom();

        const reader = new FileReader();
        reader.onload = (e) => {
            const fileContent = e.target.result;
            this.uploadFileToAi(fileContent, file.name);
        };
        reader.readAsText(file);
        
        event.target.value = '';
    }

    /**
     * @description Envoie le contenu du fichier à la nouvelle méthode IA Apex.
     */
    async uploadFileToAi(content, fileName) {
        // --- 1. DETECTION LANGUE IMMEDIATE (FICHIER) ---
        // On prend un extrait pour la détection
        const sampleText = content.substring(0, 500);
        try {
            const detected = await detectLanguage({ text: sampleText });
            if (detected && detected !== 'Unknown') {
                this.userLanguage = detected;
                console.warn('🌐 [LWC FILE] Language updated to:', this.userLanguage);
            }
        } catch(e) { 
            console.warn('Lang detect failed (file)', e); 
        }
        // -----------------------------------------------

        const rawCatalogData = this.products.map(p => this.mapProductToContext(p));
        const catalogJson = JSON.stringify(rawCatalogData);

        console.group('📂 [FILE UPLOAD DEBUG] Sending File to Apex');
        console.log('File Name:', fileName);
        console.log('File Content Preview:', content.substring(0, 200) + '...');
        console.groupEnd();

        try {
            const result = await analyzeFileWithEinstein({
                fileContent: content,
                productContextString: catalogJson,
                userContext: { userName: this.userName, language: this.userLanguage }
            });

            this.isTyping = false;
            console.log('📂 [FILE UPLOAD DEBUG] Apex Response:', result);

            if (result.success) {
                const aiData = JSON.parse(result.response);
                
                // Fallback si l'Apex détecte mieux
                if (aiData.detectedLanguage) {
                    this.userLanguage = aiData.detectedLanguage;
                }

                let tableItems = [];
                if (aiData.items && Array.isArray(aiData.items)) {
                    aiData.items.forEach(item => {
                        let realDataProduct = this.products.find(p => (p.sku === item.sku || p.StockKeepingUnit === item.sku));
                        if (realDataProduct) {
                            
                            const cardVisuals = this.formatCard(realDataProduct);
                            const contextP = this.mapProductToContext(realDataProduct);
                            
                            tableItems.push({
                                ...cardVisuals,
                                quantityRequested: item.quantity,
                                availableToAdd: contextP.stock 
                            });
                        }
                    });
                }

                if (tableItems.length > 0) {
                    this.addFileValidationMessage(aiData.message || "I found these items in your file. Please verify.", tableItems);
                } else {
                    this.addAiMessage("I analyzed the file but couldn't match any products from our catalog.");
                }

            } else {
                this.addAiMessage("⚠️ Error analyzing file: " + result.message);
            }

        } catch (error) {
            this.isTyping = false;
            console.error('❌ File Upload Error:', error);
            this.addAiMessage("Connection error during file analysis.");
        }
    }

    /**
     * @description Affiche le message spécial avec le tableau de validation.
     */
    addFileValidationMessage(text, tableItems) {
        this.messages = [...this.messages, {
            id: Date.now(),
            text: text,
            isAi: true,
            isFileResult: true, 
            fileItems: tableItems,
            wrapperClass: 'message-wrapper left',
            bubbleClass: 'chat-bubble left'
        }];
        this.scrollToBottom();
    }

    /**
     * @description Action du bouton "Add to List" dans le tableau de fichier.
     * MISE A JOUR : Applique la validation stricte des quantités (calculateValidQuantity) et génère un feedback IA si ajustements.
     */
    async handleConfirmFile(event) {
        const msgId = event.target.dataset.msgid;
        const message = this.messages.find(m => m.id == msgId);
        
        if (message && message.fileItems) {
            let addedCount = 0;
            let adjustmentLogs = [];

            message.fileItems.forEach(item => {
                // Recherche du produit réel pour avoir les règles (min, max, inc)
                const realDataProduct = this.products.find(p => (p.sku === item.sku || p.StockKeepingUnit === item.sku));
                
                if (realDataProduct) {
                    // VALIDATION STRICTE
                    const validation = this.calculateValidQuantity(realDataProduct, item.quantityRequested);
                    
                    if (validation.finalQty > 0) {
                        this.dispatchEvent(new CustomEvent('addproduct', {
                            detail: { 
                                sku: item.sku, 
                                quantity: validation.finalQty,
                                isRecommendation: false 
                            }
                        }));
                        addedCount++;
                        
                        // Si ajusté, on logue pour l'IA
                        if (validation.isAdjusted) {
                            adjustmentLogs.push(`${realDataProduct.name}: Requested ${item.quantityRequested}, Adjusted to ${validation.finalQty}. Reason: ${validation.reasons.join(', ')}.`);
                        }
                    } else {
                        // Cas échec total (ex: Stock 0)
                        adjustmentLogs.push(`${realDataProduct.name}: Could not add. Reason: ${validation.reasons.join(', ')}.`);
                    }
                }
            });

            // Feedback Interface
            if (addedCount > 0) {
                this.addMessage(`✅ Added ${addedCount} items to list.`, true);
                this.conversationContext += `\nSystem: Added ${addedCount} items from file upload.`;
            } else {
                this.addMessage("⚠️ No items could be added.", true);
            }

            // FEEDBACK IA (Si ajustements)
            if (adjustmentLogs.length > 0) {
                console.log('📝 Sending Adjustment Logs to AI:', adjustmentLogs);
                
                this.isTyping = true;
                try {
                    const explainRes = await explainAdjustmentsWithEinstein({ 
                        adjustments: adjustmentLogs,
                        userContext: { userName: this.userName, language: this.userLanguage }
                    });
                    this.isTyping = false;
                    if (explainRes.success) {
                        this.addAiMessage(explainRes.response);
                    }
                } catch(e) { this.isTyping = false; }
            }
        }
    }

    /**
     * @description Action du bouton "Cancel".
     */
    handleCancelFile(event) {
        this.addMessage("File import cancelled.", true);
    }

    // --- MESSAGE UTILISATEUR ---

    /**
     * @description Traite l'envoi du message utilisateur.
     * MISE A JOUR : Applique la validation stricte sur les actions 'add'/'set' venant de l'IA et génère un feedback.
     */
    async handleSend() {
        if (!this.userInput.trim()) return;

        const text = this.userInput;
        this.addMessage(text, false);
        this.conversationContext += `\nUser: ${text}`;
        this.userInput = '';
        this.isTyping = true;
        this.scrollToBottom();

        // --- 1. DETECTION LANGUE IMMEDIATE (AJOUT) ---
        // Appel d'Apex pour identifier la langue sur le texte actuel uniquement
        try {
            const detected = await detectLanguage({ text: text });
            if (detected && detected !== 'Unknown') {
                this.userLanguage = detected;
                console.warn('🌐 [LWC] Language updated to:', this.userLanguage);
            }
        } catch(e) { 
            console.warn('Lang detect failed', e); 
        }
        // ---------------------------------------------

        const rawCatalogData = this.products.map(p => this.mapProductToContext(p));
        const rawLastShownData = this.lastShownItems.map(item => {
            const updated = this.products.find(p => (p.sku === item.sku || p.StockKeepingUnit === item.sku));
            return updated ? this.mapProductToContext(updated) : {
                name: item.name, sku: item.sku, 
                desc: item.variationInfo || "",
                selected: 0, inCart: 0
            };
        });

        console.group('🤖 [EINSTEIN AI DEBUG] Payload sent to Apex');
        console.log('🗣️ User Conversation Context:', this.conversationContext);
        console.log('📦 Catalog Context (Full JSON):', JSON.parse(JSON.stringify(rawCatalogData)));
        console.groupEnd();

        const catalogJson = JSON.stringify(rawCatalogData);
        const lastShownJson = JSON.stringify(rawLastShownData);

        // 3. Préparation du contexte COMMANDES (Historique) - NOUVEAU
            const orderContext = this.formatOrdersForContext();

        try {
            // Appel Apex (maintenant avec userLanguage potentiellement mis à jour)
            const result = await askEinstein({ 
                userMessage: this.conversationContext,
                productContextString: catalogJson,
                lastShownContextString: lastShownJson,
                orderContext: orderContext, // NOUVEAU PARAMETRE
                userContext: { userName: this.userName, language: this.userLanguage }
            });
            
            this.isTyping = false;
            console.log('🤖 [EINSTEIN AI DEBUG] Raw Response:', result);

            if (result.success) {
                try {
                    const aiData = JSON.parse(result.response);
                    this.conversationContext += `\nAssistant: ${aiData.message}`;

                    // Fallback si l'Apex a raffiné la détection
                    if (aiData.detectedLanguage) {
                        this.userLanguage = aiData.detectedLanguage;
                    }

                    let productsToDisplay = [];
                    let adjustmentLogs = []; 
                    
                    if (aiData.items && Array.isArray(aiData.items)) {
                        aiData.items.forEach(item => {
                            let foundProduct = this.lastShownItems.find(r => r.sku === item.sku) ||
                                               this.products.find(p => (p.sku === item.sku || p.StockKeepingUnit === item.sku));
                            let realDataProduct = this.products.find(p => (p.sku === item.sku || p.StockKeepingUnit === item.sku));

                            if (foundProduct) {
                                if (!foundProduct.imgUrl && foundProduct.defaultImage) foundProduct.imgUrl = foundProduct.defaultImage.url;

                                let finalQty = 0;
                                let qtyRaw = item.quantity ? parseInt(item.quantity, 10) : 0;

                                // Logique Actions
                                if (item.action === 'set') {
                                    const currentSelected = (realDataProduct && realDataProduct.qtyValue) ? parseFloat(realDataProduct.qtyValue) : 0;
                                    finalQty = qtyRaw - currentSelected;
                                } else if (item.action === 'remove') {
                                    finalQty = -qtyRaw;
                                } else {
                                    finalQty = qtyRaw; // Cas 'add' standard
                                }

                                // VALIDATION STRICTE AVANT DISPATCH
                                if (finalQty > 0 && item.action !== 'search' && realDataProduct) {
                                    // Utilisation de la quantité BRUTE si > 9M pour activer la logique "Max"
                                    let qtyToValidate = item.quantity > 9000000 ? item.quantity : finalQty;
                                    
                                    const validation = this.calculateValidQuantity(realDataProduct, qtyToValidate);
                                    
                                    if (validation.finalQty > 0) {
                                        this.dispatchEvent(new CustomEvent('addproduct', {
                                            detail: { 
                                                sku: foundProduct.sku || foundProduct.StockKeepingUnit, 
                                                quantity: validation.finalQty,
                                                isRecommendation: false 
                                            }
                                        }));
                                        
                                        if (validation.isAdjusted) {
                                            // Message spécifique si c'était une demande "Max"
                                            if(qtyToValidate > 9000000) {
                                                adjustmentLogs.push(`${foundProduct.name}: Added ${validation.finalQty} units (Maximum available).`);
                                            } else {
                                                adjustmentLogs.push(`${foundProduct.name}: Requested ${qtyToValidate}, Adjusted to ${validation.finalQty}. (${validation.reasons.join(', ')})`);
                                            }
                                        }
                                    } else {
                                        adjustmentLogs.push(`${foundProduct.name}: Could not add. (${validation.reasons.join(', ')})`);
                                    }
                                } 
                                else if (finalQty < 0 && item.action !== 'search') {
                                     this.dispatchEvent(new CustomEvent('addproduct', {
                                        detail: { sku: foundProduct.sku || foundProduct.StockKeepingUnit, quantity: finalQty, isRecommendation: false }
                                    }));
                                }

                                productsToDisplay.push(this.formatCard(foundProduct));
                            }
                        });
                    }

                    if (productsToDisplay.length > 0) {
                        this.lastShownItems = productsToDisplay;
                    }

                    this.addAiMessage(aiData.message, productsToDisplay);

                    // FEEDBACK IA CHAT
                    if (adjustmentLogs.length > 0) {
                        console.log('📝 Sending Adjustment Logs to AI:', adjustmentLogs);
                        this.isTyping = true;
                        const explainRes = await explainAdjustmentsWithEinstein({ 
                            adjustments: adjustmentLogs,
                            userContext: { userName: this.userName, language: this.userLanguage }
                        });
                        this.isTyping = false;
                        if (explainRes.success) {
                            this.addAiMessage(explainRes.response);
                        }
                    }

                } catch (jsonError) {
                    console.error('❌ JSON Parsing Error on AI Response:', jsonError);
                    this.addMessage(result.response, true);
                }
            } else {
                this.addMessage("⚠️ " + result.message, true);
            }
        } catch (error) {
            this.isTyping = false;
            console.error('❌ Network/Apex Error:', error);
            this.addMessage("Connection error.", true);
        }
    }

    // --- HELPERS ---

    /**
     * @description Convertit une liste d'items simples en objets Card affichables.
     * @param items Liste d'objets {sku, ...}
     * @param sourceList Liste source où trouver les détails complets.
     * @return Array Liste d'objets formatés pour le template.
     */
    mapItemsToCards(items, sourceList) {
        if (!items) return [];
        return items.map(item => {
            const fullData = sourceList.find(r => r.sku === item.sku) || 
                             this.products.find(p => (p.sku === item.sku || p.StockKeepingUnit === item.sku));
            return fullData ? this.formatCard(fullData) : null;
        }).filter(x => x !== null);
    }

    /**
     * @description Formate un objet produit brut en objet utilisable pour l'affichage de la carte (Card) dans le chat.
     * AJOUT : Construction du productUrl pour lien cliquable.
     * @param p Objet produit brut.
     * @return Object Objet structuré pour le HTML.
     */
    formatCard(p) {
        let specs = [];
        if (p.variationInfo) {
            specs = p.variationInfo.split(', ').map((specStr, index) => {
                return { key: `${p.id}-spec-${index}`, label: specStr, cssClass: 'card-spec-pill' };
            });
        }

        return {
            id: p.id, 
            name: p.name, 
            sku: p.sku || p.StockKeepingUnit,
            price: p.displayUnitPrice || p.unitPrice || p.price,
            listPrice: p.listPrice || null, 
            imgUrl: p.imgUrl, 
            promo: p.promoName || p.promo,
            specs: specs, 
            currency: 'USD',
            productUrl: communityBasePath + '/product/' + p.id // CORRECTION ICI (Base Path)
        };
    }

    /**
     * @description Sérialise un produit pour le contexte JSON envoyé au LLM.
     * Calcule le stock DISPONIBLE À L'AJOUT (Physique - (Panier + Saisi)).
     * @param p Objet produit brut.
     * @return Object Objet simplifié pour le prompt JSON.
     */
    mapProductToContext(p) {
        let tierInfo = '';
        if (p.tierList) tierInfo = p.tierList.map(t => t.label).join(', ');
        const sellingPrice = p.displayUnitPrice || p.unitPrice; 

        const inCart = p.cartQty ? parseFloat(p.cartQty) : 0;
        const selected = p.qtyValue ? parseFloat(p.qtyValue) : 0;

        const isInfiniteStock = (p.stock === undefined || p.stock === null || p.stock === 'null');
        const physicalStock = isInfiniteStock ? 999999 : parseFloat(p.stock);
        
        let availableToAdd = physicalStock - inCart - selected;
        if (availableToAdd < 0) availableToAdd = 0;

        return {
            name: p.name, 
            sku: p.sku || p.StockKeepingUnit, 
            desc: p.Description + (p.variationInfo ? ' ' + p.variationInfo : ''), 
            price: sellingPrice, 
            stock: availableToAdd, 
            stockLabel: p.stockLabel, 
            selected: selected, 
            inCart: inCart,
            tiers: tierInfo
        };
    }

    /**
     * @description Ajoute un message de l'IA à la liste d'affichage.
     * @param text Le texte à afficher.
     * @param products Liste optionnelle de cartes produits à afficher sous le texte.
     */
    addAiMessage(text, products) {
        this.messages = [...this.messages, {
            id: Date.now(), text: text, isAi: true,
            products: products && products.length > 0 ? products : null,
            wrapperClass: 'message-wrapper left', bubbleClass: 'chat-bubble left'
        }];
        this.scrollToBottom();
    }

    /**
     * @description Ajoute un message (User ou System) à la liste d'affichage.
     * @param text Le texte.
     * @param isAi Booléen indiquant si c'est l'IA.
     * @param products Cartes produits (rarement utilisé ici, plutôt pour addAiMessage).
     */
    addMessage(text, isAi, products = null) {
        this.messages = [...this.messages, {
            id: Date.now(), text: text, isAi: isAi,
            products: products,
            wrapperClass: `message-wrapper ${isAi ? 'left' : 'right'}`,
            bubbleClass: `chat-bubble ${isAi ? 'left' : 'right'}`
        }];
    }

    /**
     * @description Fait défiler la fenêtre de chat vers le bas automatiquement.
     */
    scrollToBottom() {
        setTimeout(() => {
            const chatBox = this.template.querySelector('.chat-messages');
            if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
        }, 50);
    }

    /**
     * @description Gère le clic sur un bouton d'ajout manuel dans une carte produit du chat (si implémenté).
     * @param event Événement click.
     */
    handleAddRequest(event) {
        const sku = event.target.dataset.sku;
        const qty = parseInt(event.target.dataset.qty, 10);
        this.dispatchEvent(new CustomEvent('addproduct', {
            detail: { sku: sku, quantity: qty }
        }));
    }
}