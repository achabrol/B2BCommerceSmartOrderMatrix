import { LightningElement, track, api } from 'lwc';
import askEinstein from '@salesforce/apex/B2BCommerceOrderMatrixController.askEinstein';

export default class B2bAiAssistant extends LightningElement {
    
    @api products = [];

    // --- MEMOIRE (Items affichés à l'utilisateur) ---
    lastShownItems = []; 
    currentContextSource = 'user'; // 'user' ou 'system'
    // ------------------------------------------------

    @track messages = [
        { 
            id: 'welcome', 
            text: "Hello! I'm your B2B Sales Assistant. How can I help you today?", 
            isAi: true,
            wrapperClass: 'message-wrapper left', 
            bubbleClass: 'chat-bubble left' 
        }
    ];
    @track userInput = '';
    @track isTyping = false;
    
    conversationContext = ''; 

    handleInputChange(event) { this.userInput = event.target.value; }
    handleKeyUp(event) { if (event.key === 'Enter') this.handleSend(); }

    // --- TRIGGER RECO (Système) ---
    @api async triggerAiRecommendation(addedItemName, recommendedItems) {
        this.isTyping = true; 
        
        // 1. On remplit la mémoire avec les recos
        this.lastShownItems = recommendedItems || [];
        this.currentContextSource = 'system'; 

        console.log('🕵️ [AI] Trigger Reco. Items:', this.lastShownItems.length);

        const systemPrompt = `SYSTEM_CONTEXT: User just added "${addedItemName}" to cart. 
        Display these Cross-Sell recommendations (Source A). 
        INSTRUCTION: Present them briefly.`;

        // Pas de filtrage, on envoie la vérité
        const catalogJson = JSON.stringify(this.products);
        const lastShownJson = JSON.stringify(this.lastShownItems);

        try {
            const result = await askEinstein({ 
                userMessage: systemPrompt, 
                productContextString: catalogJson,
                lastShownContextString: lastShownJson 
            });

            this.isTyping = false;

            if (result.success) {
                const aiData = JSON.parse(result.response);
                // Affichage des cartes
                let cardsToDisplay = this.mapItemsToCards(aiData.items, recommendedItems);
                this.addAiMessage(aiData.message, cardsToDisplay);
                this.conversationContext += `\nAssistant: ${aiData.message}`;
            }
        } catch (e) {
            this.isTyping = false;
            console.error('AI Error', e);
        }
    }

    // --- MESSAGE UTILISATEUR ---
    async handleSend() {
        if (!this.userInput.trim()) return;

        const text = this.userInput;
        this.addMessage(text, false);
        this.conversationContext += `\nUser: ${text}`;
        
        this.userInput = '';
        this.isTyping = true;
        this.scrollToBottom();

        // Capture état avant appel
        const sourceBeforeCall = this.currentContextSource;

        // 1. Catalogue Complet (Vérité terrain)
        const catalogJson = JSON.stringify(this.products.map(p => this.mapProductToContext(p)));
        
        // 2. Items Affichés (Contexte Visuel)
        // On les mappe proprement
        const lastShownContext = this.lastShownItems.map(item => {
            const updated = this.products.find(p => (p.sku === item.sku || p.StockKeepingUnit === item.sku));
            return updated ? this.mapProductToContext(updated) : {
                name: item.name, sku: item.sku, 
                desc: (sourceBeforeCall === 'system' ? "(RECOMMENDED) " : "") + (item.variationInfo || ""),
                selected: 0, inCart: 0
            };
        });
        const lastShownJson = JSON.stringify(lastShownContext);

        console.log('🕵️ [AI] Sending Request. Source:', sourceBeforeCall);

        try {
            const result = await askEinstein({ 
                userMessage: this.conversationContext,
                productContextString: catalogJson,
                lastShownContextString: lastShownJson 
            });
            
            this.isTyping = false;

            if (result.success) {
                try {
                    const aiData = JSON.parse(result.response);
                    this.conversationContext += `\nAssistant: ${aiData.message}`;

                    let productsToDisplay = [];
                    
                    if (aiData.items && Array.isArray(aiData.items)) {
                        aiData.items.forEach(item => {
                            // Recherche : Priorité au contexte affiché, puis au catalogue
                            let foundProduct = this.lastShownItems.find(r => r.sku === item.sku) ||
                                               this.products.find(p => (p.sku === item.sku || p.StockKeepingUnit === item.sku));

                            if (foundProduct) {
                                if (!foundProduct.imgUrl && foundProduct.defaultImage) foundProduct.imgUrl = foundProduct.defaultImage.url;

                                let finalQty = 0;
                                let qtyRaw = item.quantity ? parseInt(item.quantity, 10) : 0;

                                if (item.action === 'set') {
                                    const currentSelected = foundProduct.qtyValue ? parseFloat(foundProduct.qtyValue) : 0;
                                    finalQty = qtyRaw - currentSelected;
                                } else if (item.action === 'remove') {
                                    finalQty = -qtyRaw;
                                } else {
                                    finalQty = qtyRaw;
                                }

                                // Info pour le parent : Est-ce que cet item vient de la liste "Système" (Recommandation) ?
                                // Cela permet au parent d'arrêter la boucle SI C'EST UNE COMMANDE SUR LA RECO.
                                const isSystemReco = (sourceBeforeCall === 'system') && this.lastShownItems.some(r => r.sku === item.sku);
                                
                                console.log(`🕵️ [AI] Item ${item.sku}. IsSystemReco? ${isSystemReco}`);

                                // Pas de blocage artificiel. On transmet l'intention de l'IA.
                                if (finalQty !== 0 && item.action !== 'search') {
                                    this.dispatchEvent(new CustomEvent('addproduct', {
                                        detail: { 
                                            sku: foundProduct.sku || foundProduct.StockKeepingUnit, 
                                            quantity: finalQty,
                                            isRecommendation: isSystemReco // Flag transmis au parent
                                        }
                                    }));
                                }
                                productsToDisplay.push(this.formatCard(foundProduct));
                            }
                        });
                    }

                    // Mise à jour de la mémoire : Si l'IA affiche de nouveaux produits, le contexte change.
                    if (productsToDisplay.length > 0) {
                        this.lastShownItems = productsToDisplay;
                        this.currentContextSource = 'user'; // On repasse la main à l'utilisateur
                        console.log('🕵️ [AI] Memory Updated -> New Source: USER');
                    }

                    this.addAiMessage(aiData.message, productsToDisplay);

                } catch (jsonError) {
                    console.error('JSON Error', jsonError);
                    this.addMessage(result.response, true);
                }
            } else {
                this.addMessage("⚠️ " + result.message, true);
            }
        } catch (error) {
            this.isTyping = false;
            this.addMessage("Connection error.", true);
        }
    }

    // --- HELPERS (Inchangés) ---
    mapItemsToCards(items, sourceList) {
        if (!items) return [];
        return items.map(item => {
            const fullData = sourceList.find(r => r.sku === item.sku) || 
                             this.products.find(p => (p.sku === item.sku || p.StockKeepingUnit === item.sku));
            return fullData ? this.formatCard(fullData) : null;
        }).filter(x => x !== null);
    }

    formatCard(p) {
        return {
            id: p.id, name: p.name, sku: p.sku || p.StockKeepingUnit,
            price: p.displayUnitPrice || p.unitPrice || p.price,
            imgUrl: p.imgUrl, promo: p.promoName || p.promo,
            currency: 'USD'
        };
    }

    mapProductToContext(p) {
        let tierInfo = '';
        if (p.tierList) tierInfo = p.tierList.map(t => t.label).join(', ');
        const sellingPrice = p.displayUnitPrice || p.unitPrice; 
        return {
            name: p.name, sku: p.sku || p.StockKeepingUnit, 
            desc: p.Description + (p.variationInfo ? ' ' + p.variationInfo : ''), 
            price: sellingPrice, stock: 'Available', 
            selected: p.qtyValue || 0, inCart: p.cartQty || 0,
            tiers: tierInfo
        };
    }

    addAiMessage(text, products) {
        this.messages = [...this.messages, {
            id: Date.now(), text: text, isAi: true,
            products: products && products.length > 0 ? products : null,
            wrapperClass: 'message-wrapper left', bubbleClass: 'chat-bubble left'
        }];
        this.scrollToBottom();
    }

    addMessage(text, isAi, products = null) {
        this.messages = [...this.messages, {
            id: Date.now(), text: text, isAi: isAi,
            products: products,
            wrapperClass: `message-wrapper ${isAi ? 'left' : 'right'}`,
            bubbleClass: `chat-bubble ${isAi ? 'left' : 'right'}`
        }];
    }

    scrollToBottom() {
        setTimeout(() => {
            const chatBox = this.template.querySelector('.chat-messages');
            if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
        }, 50);
    }

    handleAddRequest(event) {
        const sku = event.target.dataset.sku;
        const qty = parseInt(event.target.dataset.qty, 10);
        this.dispatchEvent(new CustomEvent('addproduct', {
            detail: { sku: sku, quantity: qty }
        }));
    }
}