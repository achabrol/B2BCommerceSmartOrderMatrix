/**
 * @description Contrôleur B2B Order Matrix
 * VERSION DEBUG & CONTEXTE RENFORCÉ
 */
public without sharing class B2BCommerceOrderMatrixController {

    // --- 1. CATALOGUE (INCHANGÉ) ---
    @AuraEnabled
    public static Map<String, Object> getAllActiveProducts(String communityId, String effectiveAccountId) {
        String webstoreId = resolveWebstoreId(communityId);
        String accountId = String.isNotBlank(effectiveAccountId) ? effectiveAccountId : null;
        Map<String, Object> responseMap = new Map<String, Object>();
        responseMap.put('webstoreId', webstoreId);

        if (String.isBlank(webstoreId)) {
            responseMap.put('error', 'WebStore ID not found.');
            return responseMap;
        }

        String catalogId = getCatalogId(webstoreId);
        Set<String> rootCategoryIds = new Set<String>();
        if (String.isNotBlank(catalogId)) {
            for (ProductCategory r : [SELECT Id FROM ProductCategory WHERE CatalogId = :catalogId AND ParentCategoryId = null]) {
                rootCategoryIds.add(r.Id);
            }
        }

        if (rootCategoryIds.isEmpty()) {
            responseMap.put('products', new List<Map<String, Object>>());
            return responseMap;
        }

        Map<String, ConnectApi.ProductSummary> uniqueProductMap = new Map<String, ConnectApi.ProductSummary>();
        
        try {
            for (String catId : rootCategoryIds) {
                Integer pageNumber = 0; 
                Boolean hasMore = true;
                
                while(hasMore) {
                    ConnectApi.ProductSearchInput input = new ConnectApi.ProductSearchInput();
                    input.categoryId = catId;
                    input.pageSize = 200; 
                    input.page = pageNumber;
                    input.includeQuantityRule = true;
                    input.fields = new List<String>{'StockKeepingUnit', 'Description'};

                    ConnectApi.ProductSearchResults results = ConnectApi.CommerceSearch.searchProducts(webstoreId, accountId, input);
                    
                    if (results?.productsPage?.products != null) {
                        for (ConnectApi.ProductSummary ps : results.productsPage.products) {
                            if (!uniqueProductMap.containsKey(ps.id) && ps.productClass != ConnectApi.ProductClass.VariationParent) {
                                uniqueProductMap.put(ps.id, ps);
                            }
                        }
                        
                        if (results.productsPage.products.size() < input.pageSize) {
                            hasMore = false; 
                        } else {
                            pageNumber++;
                            if (pageNumber > 20) hasMore = false; 
                        }
                    } else {
                        hasMore = false;
                    }
                }
            }
        } catch (Exception e) { System.debug('Search Error: ' + e.getMessage()); }

        return buildResponseFromSummaries(uniqueProductMap.values(), webstoreId, accountId);
    }

    // --- 2. PAST ORDERS (INCHANGÉ) ---
    @AuraEnabled
    public static Map<String, Object> getPastOrders(String effectiveAccountId, String fromDateStr, String toDateStr) {
        Date fromDate = String.isNotBlank(fromDateStr) ? Date.valueOf(fromDateStr) : null;
        Date toDate = String.isNotBlank(toDateStr) ? Date.valueOf(toDateStr) : null;
        
        String query = 'SELECT Id, OrderNumber, OrderedDate, GrandTotalAmount, Status, CurrencyIsoCode FROM OrderSummary WHERE AccountId = :effectiveAccountId ';
        if (fromDate != null) query += 'AND OrderedDate >= :fromDate ';
        if (toDate != null) query += 'AND OrderedDate <= :toDate ';
        query += 'ORDER BY OrderedDate DESC LIMIT 100';

        List<OrderSummary> orders = Database.query(query);
        List<Map<String, Object>> orderList = new List<Map<String, Object>>();
        Set<Id> orderIds = new Set<Id>();
        
        for (OrderSummary ord : orders) {
            orderIds.add(ord.Id);
            orderList.add(new Map<String, Object>{ 'id' => ord.Id, 'orderNumber' => ord.OrderNumber, 'orderedDate' => ord.OrderedDate.format('yyyy-MM-dd HH:mm'), 'grandTotalAmount' => ord.GrandTotalAmount, 'status' => ord.Status, 'currencyIsoCode' => ord.CurrencyIsoCode });
        }

        List<Map<String, Object>> allItemsList = new List<Map<String, Object>>();
        if (!orderIds.isEmpty()) {
            List<OrderItemSummary> allItems = [SELECT OrderSummaryId, Product2Id, Quantity FROM OrderItemSummary WHERE OrderSummaryId IN :orderIds AND Product2Id != null AND Type != 'Delivery Charge' AND OriginalOrderItem.ParentOrderItemId = null];
            for(OrderItemSummary item : allItems) { allItemsList.add(new Map<String, Object>{ 'orderId' => item.OrderSummaryId, 'productId' => item.Product2Id, 'quantity' => item.Quantity }); }
        }
        return new Map<String, Object>{ 'orders' => orderList, 'allItems' => allItemsList };
    }

    // --- 3. ORDER PRODUCTS (INCHANGÉ) ---
    @AuraEnabled
    public static Map<String, Object> getOrderProducts(String communityId, String effectiveAccountId, String orderSummaryId, Boolean skipEnrichment) {
        String webstoreId = resolveWebstoreId(communityId);
        String accountId = String.isNotBlank(effectiveAccountId) ? effectiveAccountId : null;

        Map<String, Object> responseMap = new Map<String, Object>();
        responseMap.put('products', new List<Map<String, Object>>()); 
        responseMap.put('orderQuantities', new List<Map<String, Object>>());
        
        if (String.isBlank(webstoreId)) return responseMap;

        List<OrderItemSummary> orderItems = [SELECT Product2Id, Quantity FROM OrderItemSummary WHERE OrderSummaryId = :orderSummaryId AND Product2Id != null AND Type != 'Delivery Charge' AND OriginalOrderItem.ParentOrderItemId = null];
        if (orderItems.isEmpty()) return responseMap;

        Set<String> validProductIds = new Set<String>();
        List<Map<String, Object>> quantitiesList = new List<Map<String, Object>>();
        for (OrderItemSummary oi : orderItems) { validProductIds.add(oi.Product2Id); quantitiesList.add(new Map<String, Object>{ 'productId' => oi.Product2Id, 'quantity' => oi.Quantity }); }
        responseMap.put('orderQuantities', quantitiesList);

        if (skipEnrichment == true) return responseMap; 

        List<Product2> dbProducts = [SELECT Id, StockKeepingUnit FROM Product2 WHERE Id IN :validProductIds];
        List<String> skusToSearch = new List<String>();
        for(Product2 p : dbProducts) { if(String.isNotBlank(p.StockKeepingUnit) && p.StockKeepingUnit != '999999') skusToSearch.add(p.StockKeepingUnit); }

        Map<String, ConnectApi.ProductSummary> summaryMap = new Map<String, ConnectApi.ProductSummary>();
        if(!skusToSearch.isEmpty()) {
            try {
                ConnectApi.ProductSearchInput input = new ConnectApi.ProductSearchInput();
                input.searchTerm = String.join(skusToSearch, ' '); input.pageSize = 100; input.includeQuantityRule = true; input.fields = new List<String>{'StockKeepingUnit', 'Description'};
                ConnectApi.ProductSearchResults results = ConnectApi.CommerceSearch.searchProducts(webstoreId, accountId, input);
                if (results?.productsPage?.products != null) { for (ConnectApi.ProductSummary ps : results.productsPage.products) { if (validProductIds.contains(ps.id)) summaryMap.put(ps.id, ps); } }
            } catch(Exception e) {}
        }
        Map<String, Object> builtData = buildResponseFromSummaries(summaryMap.values(), webstoreId, accountId);
        responseMap.put('products', builtData.get('products'));
        return responseMap;
    }

    // --- HELPER PRINCIPAL (INCHANGÉ) ---
    private static Map<String, Object> buildResponseFromSummaries(List<ConnectApi.ProductSummary> summaries, String webstoreId, String accountId) {
        Map<String, Object> responseMap = new Map<String, Object>();
        if (summaries == null || summaries.isEmpty()) {
            responseMap.put('products', new List<Map<String, Object>>());
            return responseMap;
        }

        Set<String> skus = new Set<String>();
        Set<String> variationProductIds = new Set<String>();

        for(ConnectApi.ProductSummary ps : summaries) {
            String sku = null;
            if (ps.fields != null && ps.fields.containsKey('StockKeepingUnit')) {
                sku = (String) ps.fields.get('StockKeepingUnit').value;
            }
            if(String.isNotBlank(sku)) skus.add(sku);

            if (ps.productClass == ConnectApi.ProductClass.Variation) {
                variationProductIds.add(ps.id);
            }
        }
        
        Map<String, String> ociStockMap = getOCIStockMap(webstoreId, skus);
        Map<String, String> variationAttributesMap = getVariationInfoMapDynamic(variationProductIds);

        List<Map<String, Object>> resultList = new List<Map<String, Object>>();

        for (ConnectApi.ProductSummary ps : summaries) {
            Map<String, Object> d = new Map<String, Object>();
            d.put('id', ps.id);
            d.put('name', ps.name);
            d.put('imgUrl', (ps.defaultImage != null) ? ps.defaultImage.url : '');
            
            String sku = '';
            String description = '';
            if (ps.fields != null) {
                if (ps.fields.containsKey('StockKeepingUnit')) {
                    sku = (String) ps.fields.get('StockKeepingUnit').value;
                }
                if (ps.fields.containsKey('Description')) {
                    description = (String) ps.fields.get('Description').value;
                } else if (ps.fields.containsKey('description')) { 
                    description = (String) ps.fields.get('description').value;
                }
            }
            d.put('sku', sku);
            d.put('Description', description);
            
            d.put('variationInfo', variationAttributesMap.containsKey(ps.id) ? variationAttributesMap.get(ps.id) : '');

            d.put('unitPrice', 0); d.put('listPrice', 0); d.put('currencyCode', 'USD'); d.put('priceRanges', new List<Map<String, Object>>());
            d.put('stock', (String.isNotBlank(sku) && ociStockMap.containsKey(sku)) ? ociStockMap.get(sku) : null);

            try {
                ConnectApi.ProductPrice priceData = ConnectApi.CommerceStorePricing.getProductPrice(webstoreId, ps.id, accountId);
                if (priceData != null) {
                    d.put('unitPrice', priceData.unitPrice); d.put('listPrice', priceData.listPrice); d.put('currencyCode', priceData.currencyIsoCode);
                    if (priceData.priceAdjustment?.priceAdjustmentTiers != null) {
                        List<Map<String, Object>> ranges = new List<Map<String, Object>>();
                        for (ConnectApi.PriceAdjustmentTier tier : priceData.priceAdjustment.priceAdjustmentTiers) {
                            ranges.add(new Map<String, Object>{ 'min' => tier.lowerBound, 'price' => tier.tierUnitPrice });
                        }
                        d.put('priceRanges', ranges);
                    }
                }
            } catch (Exception e) {}

            Object rawMin = (ps.purchaseQuantityRule != null) ? ps.purchaseQuantityRule.minimum : null;
            d.put('minQty', (rawMin != null) ? Decimal.valueOf(String.valueOf(rawMin)) : 1);
            Object rawMax = (ps.purchaseQuantityRule != null) ? ps.purchaseQuantityRule.maximum : null;
            d.put('maxQty', (rawMax != null) ? Decimal.valueOf(String.valueOf(rawMax)) : null);
            Object rawInc = (ps.purchaseQuantityRule != null) ? ps.purchaseQuantityRule.increment : null;
            d.put('increment', (rawInc != null) ? Decimal.valueOf(String.valueOf(rawInc)) : 1);

            resultList.add(d);
        }
        responseMap.put('products', resultList);
        return responseMap;
    }

    // --- HELPER VARIATIONS (INCHANGÉ) ---
    private static Map<String, String> getVariationInfoMapDynamic(Set<String> productIds) {
        Map<String, String> results = new Map<String, String>();
        if (productIds.isEmpty()) return results;
        
        Map<String, Schema.SObjectField> fieldMap = Schema.SObjectType.ProductAttribute.fields.getMap();
        List<String> variationFields = new List<String>();
        
        for (String fieldName : fieldMap.keySet()) {
            Schema.DescribeFieldResult dfr = fieldMap.get(fieldName).getDescribe();
            if (dfr.isCustom()) {
                String label = dfr.getLabel();
                if (!label.containsIgnoreCase('External ID')) {
                    variationFields.add(dfr.getName());
                }
            }
        }
        
        if (variationFields.isEmpty()) return results;
        
        String query = 'SELECT ProductId, ' + String.join(variationFields, ', ') + ' FROM ProductAttribute WHERE ProductId IN :productIds';
        
        try {
            List<SObject> attributes = Database.query(query);
            for (SObject attr : attributes) {
                String pId = (String) attr.get('ProductId');
                List<String> activeVars = new List<String>();
                for (String field : variationFields) {
                    try {
                        Object val = attr.get(field);
                        if (val != null) {
                            String label = fieldMap.get(field).getDescribe().getLabel();
                            if (!label.containsIgnoreCase('External ID')) {
                                activeVars.add(label + ': ' + String.valueOf(val));
                            }
                        }
                    } catch(Exception ex) {}
                }
                if (!activeVars.isEmpty()) results.put(pId, String.join(activeVars, ', '));
            }
        } catch (Exception e) {}
        return results;
    }
    
    // ... (Helpers Cart/OCI INCHANGÉS) ...
    @AuraEnabled
    public static void addItemsToCart(String communityId, String effectiveAccountId, Map<String, Double> itemsMap) {
        String webstoreId = resolveWebstoreId(communityId);
        ConnectApi.CartInput cartInput = new ConnectApi.CartInput();
        cartInput.effectiveAccountId = effectiveAccountId;
        String cartId;
        try {
            ConnectApi.CartSummary summary = ConnectApi.CommerceCart.getCartSummary(webstoreId, effectiveAccountId, 'active');
            cartId = summary.cartId;
        } catch(Exception e) {
            cartId = ConnectApi.CommerceCart.createCart(webstoreId, cartInput).cartId;
        }
        List<ConnectApi.BatchInput> batchInputs = new List<ConnectApi.BatchInput>();
        for (String productId : itemsMap.keySet()) {
            ConnectApi.CartItemInput item = new ConnectApi.CartItemInput();
            item.productId = productId;
            item.quantity = String.valueOf(itemsMap.get(productId));
            item.type = ConnectApi.CartItemType.PRODUCT;
            batchInputs.add(new ConnectApi.BatchInput(item));
        }
        if (!batchInputs.isEmpty()) { ConnectApi.CommerceCart.addItemsToCart(webstoreId, effectiveAccountId, cartId, batchInputs); }
    }

    @AuraEnabled
    public static Map<String, Decimal> getCartQuantities(String communityId, String effectiveAccountId, List<String> productIds, String activeCartId) {
        Map<String, Decimal> cartMap = new Map<String, Decimal>();
        if (String.isNotBlank(activeCartId)) {
            for(CartItem item : [SELECT Product2Id, Quantity FROM CartItem WHERE CartId = :activeCartId AND Product2Id IN :productIds]) { cartMap.put(item.Product2Id, item.Quantity); }
        }
        return cartMap;
    }

    private static Map<String, String> getOCIStockMap(String webstoreId, Set<String> skus) {
        Map<String, String> stockMap = new Map<String, String>();
        if (skus.isEmpty()) return stockMap;
        try {
            Map<String, String> oci = resolveOCISource(webstoreId);
            if (oci.get('IsEnabled') == 'true') {
                ConnectApi.OCIGetInventoryAvailabilityInputRepresentation input = new ConnectApi.OCIGetInventoryAvailabilityInputRepresentation();
                input.stockKeepingUnits = new List<String>(skus);
                if (oci.get('Type') == 'Location') input.locationIdentifiers = new List<String>{ oci.get('Identifier') };
                else input.locationGroupIdentifiers = new List<String>{ oci.get('Identifier') };
                Object res = ConnectApi.OmnichannelInventoryService.getInventoryAvailability(input);
                Map<String, Object> resMap = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(res));
                List<Object> allRecords = new List<Object>();
                if (resMap.containsKey('locations')) for(Object loc : (List<Object>)resMap.get('locations')) allRecords.addAll((List<Object>)((Map<String, Object>)loc).get('inventoryRecords'));
                else if (resMap.containsKey('locationGroups')) for(Object grp : (List<Object>)resMap.get('locationGroups')) allRecords.addAll((List<Object>)((Map<String, Object>)grp).get('inventoryRecords'));
                for(Object r : allRecords) { Map<String, Object> rec = (Map<String, Object>) r; stockMap.put((String)rec.get('stockKeepingUnit'), String.valueOf(rec.get('availableToFulfill'))); }
            }
        } catch(Exception e) {}
        return stockMap;
    }
    private static String getCatalogId(String webstoreId) {
        List<SObject> links = Database.query('SELECT ProductCatalogId FROM WebStoreCatalog WHERE SalesStoreId = :webstoreId LIMIT 1');
        if (links.isEmpty()) links = Database.query('SELECT ProductCatalogId FROM WebStoreCatalog WHERE WebStoreId = :webstoreId LIMIT 1');
        return links.isEmpty() ? null : (String) links[0].get('ProductCatalogId');
    }
    private static Map<String, String> resolveOCISource(String webstoreId) {
        Map<String, String> res = new Map<String, String>{ 'IsEnabled' => 'false' };
        List<WebStoreInventorySource> sources = [SELECT IsEnabled, LocationSourceId, LocationSource.Type FROM WebStoreInventorySource WHERE WebStoreId = :webstoreId LIMIT 1];
        if (!sources.isEmpty()) {
            res.put('IsEnabled', String.valueOf(sources[0].IsEnabled));
            res.put('Type', sources[0].LocationSource.Type);
            String sid = sources[0].LocationSourceId;
            String q = (sources[0].LocationSource.Type == 'Location') ? 'SELECT ExternalReference FROM Location WHERE Id = :sid' : 'SELECT ExternalReference FROM LocationGroup WHERE Id = :sid';
            List<SObject> locs = Database.query(q.replace(':sid', '\''+sid+'\''));
            if (!locs.isEmpty()) res.put('Identifier', (String) locs[0].get('ExternalReference'));
        }
        return res;
    }
    private static String resolveWebstoreId(String communityId) {
        try {
            List<WebStoreNetwork> wsn = [SELECT WebStoreId FROM WebStoreNetwork WHERE NetworkId = :communityId LIMIT 1];
            if (!wsn.isEmpty()) return wsn[0].WebStoreId;
        } catch (Exception e) {}
        if (!Test.isRunningTest()) {
            List<WebStore> stores = [SELECT Id FROM WebStore LIMIT 1];
            if (!stores.isEmpty()) return stores[0].Id;
        }
        return null;
    }

  // --- 5. EINSTEIN AI CHAT ---
    @AuraEnabled
    public static Map<String, Object> askEinstein(String userMessage, String productContextString) {
        Map<String, Object> result = new Map<String, Object>();
        
        try {
            ConnectApi.EinsteinLlmGenerationsInput generationsInput = new ConnectApi.EinsteinLlmGenerationsInput();
            
            String prompt = 'You are a friendly B2B Sales Assistant.\n';
            prompt += 'You have access to CATALOG DATA (JSON).\n\n';
            
            prompt += '### DATA:\n' + productContextString + '\n\n';
            
            prompt += '### INSTRUCTIONS:\n';
            
            // 1. VISUAL CARDS
            prompt += '1. VISUAL CARDS (VERY IMPORTANT):\n';
            prompt += '   - If you recommend or discuss specific products, YOU MUST include them in the "items" array in the JSON output.\n';
            prompt += '   - Use action="search" for recommendations.\n';
            prompt += '   - This will automatically display a visual card with image, price, and specs.\n';
            
            // 2. TEXTE
            prompt += '2. TEXT MESSAGE:\n';
            prompt += '   - Keep the text SHORT and CLEAN.\n';
            prompt += '   - DO NOT list prices, stock, or technical specs in the text (the user sees them on the cards).\n';
            prompt += '   - Just give a friendly summary: "Here are the models I found for you..."\n';
            prompt += '   - Mention differences briefly (e.g., "I have it in Blue and Red") but let the cards show details.\n';
            prompt += '   - Use the USER\'S LANGUAGE (e.g. French, English).\n';

            // --- NOUVEAU CASE 3 : SYSTEM CONTEXT (Cross-Sell) ---
            prompt += '3. SCENARIO: SYSTEM_CONTEXT (Cross-Sell):\n';
            prompt += '   - If the user input starts with "SYSTEM_CONTEXT:", it means the user performed an action (like adding to cart) and the system found cross-sell items.\n';
            prompt += '   - YOUR JOB: Acknowledge the action (e.g., "Added to cart") AND naturally suggest the recommended items provided in the context.\n';
            prompt += '   - Example: "Great choice! I\'ve added that to your order. Other customers often pair it with these items:"\n';
            // ----------------------------------------------------

            // 4. ACTIONS & INTENTS (CRITICAL RULES)
            prompt += '4. ACTIONS & INTENTS (CRITICAL RULES):\n';
            
            prompt += '   - CASE 1: "ADD" (Relative)\n';
            prompt += '     User says: "Add 5", "Plus 5", "Put 5 more".\n';
            prompt += '     -> OUTPUT: action="add", quantity=5.\n';
            
            prompt += '   - CASE 2: "REMOVE" (Relative)\n';
            prompt += '     User says: "Remove 2", "Delete 2", "Less 5".\n';
            prompt += '     -> OUTPUT: action="remove", quantity=2.\n';

            prompt += '   - CASE 3: "SET / TARGET" (Absolute) - PRIORITY\n';
            prompt += '     User says: "I want 10", "Actually 10", "Just 10", "Only 10", "Set to 5".\n';
            prompt += '     -> OUTPUT: action="set", quantity=10.\n';
            prompt += '     (NEVER use "add" for these phrases. "I want 10" means the result is 10, not +10).\n';

            prompt += '   - CASE 4: "REMOVE ALL"\n';
            prompt += '     -> OUTPUT: action="set", quantity=0.\n';

            // --- MODIFICATION MAJEURE DU CASE 5 ---
            prompt += '   - CASE 5: "ADD THEM" / "ADD RECOMMENDATIONS" / "ADD OF EACH" (Contextual):\n';
            prompt += '     IF the user responds to a recommendation (e.g., "Add 5 of each", "Yes please"):\n';
            prompt += '     1. STRICTLY IGNORE any item where "selected" is greater than 0. Do NOT output them.\n';
            prompt += '     2. TARGET ONLY items where "desc" contains "(Recommended)".\n';
            prompt += '     3. IF no recommended items found, ask for clarification.\n';
            // --------------------------------------

            prompt += '5. OUTPUT FORMAT (JSON ONLY):\n';
            prompt += '   { \n';
            prompt += '     "message": "Short text summary", \n';
            prompt += '     "items": [ \n';
            prompt += '        { "sku": "FOUND_SKU", "quantity": NUMBER, "action": "add" OR "remove" OR "set" OR "search" } \n';
            prompt += '     ] \n';
            prompt += '   }\n\n';
            
            prompt += '### USER SAYS:\n' + userMessage;
            
            generationsInput.promptTextorId = prompt;
            generationsInput.additionalConfig = new ConnectApi.EinsteinLlmAdditionalConfigInput();
            generationsInput.additionalConfig.maxTokens = 800;
            generationsInput.additionalConfig.temperature = 0.1; // Température réduite pour plus de rigueur
            generationsInput.additionalConfig.applicationName = 'PromptBuilderPreview';
            
            ConnectApi.EinsteinLLMGenerationsOutput generationsOutput = ConnectApi.EinsteinLLM.generateMessages(generationsInput);
            String aiResponseText = generationsOutput.generations[0].text;
            
            aiResponseText = aiResponseText.replace('```json', '').replace('```', '').trim();
            
            result.put('success', true);
            result.put('response', aiResponseText);

        } catch (Exception e) {
            System.debug('Einstein Error: ' + e.getMessage());
            result.put('success', false);
            result.put('message', 'Error: ' + e.getMessage());
        }
        
        return result;
    }
}