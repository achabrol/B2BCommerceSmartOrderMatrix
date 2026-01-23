import { LightningElement, track, api } from 'lwc';
import askEinstein from '@salesforce/apex/B2BCommerceOrderMatrixController.askEinstein';

export default class B2bAiAssistant extends LightningElement {
    
    // Reçoit la liste enrichie (avec promos, prix calculés) du parent
    @api products = [];

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
    
    // Mémoire de la conversation
    conversationContext = ''; 

    handleInputChange(event) { this.userInput = event.target.value; }
    handleKeyUp(event) { if (event.key === 'Enter') this.handleSend(); }

    async handleSend() {
        if (!this.userInput.trim()) return;

        const text = this.userInput;
        
        // 1. Affiche le message utilisateur
        this.addMessage(text, false);
        this.conversationContext += `\nUser: ${text}`;
        
        this.userInput = '';
        this.isTyping = true;
        this.scrollToBottom();

        // =================================================================
        // 2. PRÉPARATION DU CONTEXTE (Mapping complet pour l'IA)
        // =================================================================
        const contextData = this.products.map(p => {
            // Gestion des prix dégressifs (Tiers)
            let tierInfo = '';
            if (p.tierList && p.tierList.length > 0) {
                tierInfo = p.tierList.map(t => t.label).join(', ');
            }
            
            // LOGIQUE DE PRIX (Promo vs Standard)
            // displayUnitPrice = Prix final payé (rouge si promo)
            // unitPrice = Prix de base système
            const sellingPrice = p.displayUnitPrice || p.unitPrice; 
            
            // On cherche le prix barré
            let standardPrice = p.displayListPrice;
            
            // Si pas de prix barré explicite mais que le prix de vente est inférieur au prix unitaire,
            // alors le prix unitaire devient la référence barrée.
            if (!standardPrice && sellingPrice !== p.unitPrice) {
                standardPrice = p.unitPrice;
            }

            // GESTION DU STOCK (Nombre ou "Unlimited")
            // Si p.stock existe (nombre ou string non vide), on le garde.
            // Sinon (null/undefined), on dit que c'est "Unlimited" pour ne pas bloquer l'IA.
            let stockVal = 'Unlimited';
            if (p.stock !== undefined && p.stock !== null && p.stock !== '') {
                 stockVal = p.stock;
            }

            return {
                name: p.name,
                sku: p.sku || p.StockKeepingUnit, 
                desc: p.Description || '',
                
                // --- PRIX ---
                price: sellingPrice,       // Prix actuel (pour l'IA)
                listPrice: standardPrice,  // Prix d'origine (pour comparaison IA)
                promo: p.promoName || '',  // Texte promo (ex: "10% OFF")
                
                // --- STOCK & QUANTITÉS ---
                stock: stockVal,             // Niveau de stock ou Unlimited
                selected: p.qtyValue || 0,   // Quantité actuellement saisie dans la grille
                inCart: p.cartQty || 0,      // Quantité déjà dans le panier backend

                // --- RÈGLES ---
                min: p.minQty || 1,
                max: p.maxQty || '',
                inc: p.increment || 1,
                tiers: tierInfo
            };
        });

        const contextString = JSON.stringify(contextData); 
        
        // 🔍 DEBUG : Voir ce qui est envoyé à l'IA
        console.log('🔥 [AI DEBUG] Full Context Sent to Einstein:', JSON.parse(contextString));

        try {
            // 3. APPEL APEX
            const result = await askEinstein({ 
                userMessage: this.conversationContext,
                productContextString: contextString
            });
            
            this.isTyping = false;

            if (result.success) {
                try {
                    // 4. TRAITEMENT RÉPONSE JSON
                    const aiData = JSON.parse(result.response);
                    
                    // Ajout à l'historique
                    this.conversationContext += `\nAssistant: ${aiData.message}`;

                    let productsToDisplay = [];
                    
                    // Gestion des items retournés (Multi-add / Remove / Search)
                    if (aiData.items && Array.isArray(aiData.items)) {
                        aiData.items.forEach(item => {
                            // Retrouver le produit localement
                            const foundProduct = this.products.find(p => 
                                (p.sku === item.sku) || (p.StockKeepingUnit === item.sku)
                            );

                            if (foundProduct) {
                                // GESTION DES ACTIONS (ADD / REMOVE)
                                if (item.action === 'add' || item.action === 'remove') {
                                    
                                    // a. Récupération quantité brute (absolue)
                                    let qtyRaw = item.quantity ? parseInt(item.quantity, 10) : 1;
                                    
                                    // b. Si c'est un AJOUT, on respecte le minimum
                                    if (item.action === 'add') {
                                        const min = foundProduct.minQty || 1;
                                        if (qtyRaw < min) qtyRaw = min;
                                    }

                                    // c. Si c'est un RETRAIT, on inverse le signe
                                    // (Le parent fera : QuantitéActuelle + (-qtyRaw))
                                    let finalQty = (item.action === 'remove') ? -qtyRaw : qtyRaw;

                                    // d. Déclenchement de l'événement
                                    this.dispatchEvent(new CustomEvent('addproduct', {
                                        detail: { 
                                            sku: foundProduct.sku || foundProduct.StockKeepingUnit, 
                                            quantity: finalQty 
                                        }
                                    }));
                                }
                                
                                // On prépare le produit pour l'affichage de la carte
                                productsToDisplay.push(foundProduct);
                            }
                        });
                    }

                    // Affiche le message de l'IA + les cartes produits
                    this.addMessage(aiData.message, true, productsToDisplay);

                } catch (jsonError) {
                    console.error('JSON Parse Error:', jsonError);
                    // Fallback si l'IA répond en texte brut
                    this.addMessage(result.response, true);
                    this.conversationContext += `\nAssistant: ${result.response}`;
                }

            } else {
                this.addMessage("⚠️ " + result.message, true);
            }

        } catch (error) {
            this.isTyping = false;
            console.error('LWC Error:', error);
            this.addMessage("Sorry, connection error.", true);
        }

        this.scrollToBottom();
    }

    // Helper pour construire l'objet message affiché dans le HTML
    addMessage(text, isAi, products = null) {
        let productCards = [];
        
        if (products) {
            const list = Array.isArray(products) ? products : [products];
            
            productCards = list.map(p => {
                // Même logique de prix pour l'affichage de la carte
                const sellingPrice = p.displayUnitPrice || p.unitPrice;
                let standardPrice = p.displayListPrice;
                if (!standardPrice && sellingPrice !== p.unitPrice) {
                    standardPrice = p.unitPrice;
                }

                return {
                    id: p.id,
                    name: p.name,
                    sku: p.sku || p.StockKeepingUnit,
                    price: sellingPrice,
                    imgUrl: p.imgUrl,
                    promo: p.promoName,
                    listPrice: standardPrice, // Prix barré
                    currency: p.currencyCode || 'USD'
                };
            });
        }

        this.messages = [...this.messages, {
            id: Date.now(),
            text: text,
            isAi: isAi,
            products: productCards.length > 0 ? productCards : null,
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

    // Clic manuel sur le bouton "Add +1" dans le chat
    handleAddRequest(event) {
        const sku = event.target.dataset.sku;
        const qty = parseInt(event.target.dataset.qty, 10);
        this.dispatchEvent(new CustomEvent('addproduct', {
            detail: { sku: sku, quantity: qty }
        }));
    }
}