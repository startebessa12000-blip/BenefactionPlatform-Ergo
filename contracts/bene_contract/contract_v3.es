{
  val r8 = SELF.R8[Coll[Coll[Byte]]].get
  val ownerErgotree = r8(0)
  val devFeeContractBytesHash = r8(1)
  val devFee = byteArrayToBigInt(r8(2))
  val pftTokenId = r8(3)
  val baseTokenId = if (r8.size > 4) r8(4) else Coll[Byte]()

  val selfId = SELF.tokens(0)._1
  val selfAPTId = SELF.tokens(1)._1
  val selfAPT = SELF.tokens(1)._2
  val selfValue = SELF.value
  val selfBlockLimit = SELF.R4[(Boolean, Long)].get
  val selfMinimumTokensSold = SELF.R5[Long].get
  val selfSoldCounter = SELF.R6[Coll[Long]].get(0)
  val selfRefundCounter = SELF.R6[Coll[Long]].get(1)
  val selfAuxiliarExchangeCounter = SELF.R6[Coll[Long]].get(2)
  val selfExchangeRate = SELF.R7[Long].get
  val selfConstants = SELF.R8[Coll[Coll[Byte]]].get
  val selfProjectMetadata = SELF.R9[Coll[Byte]].get
  val selfScript = SELF.propositionBytes

  val terminalScript = fromBase16("1906010100d17300")
  val replicas = OUTPUTS.filter({ (b: Box) => b.propositionBytes == selfScript })
  val noExtraReplicas = replicas.size <= 1
  val isReplicationBoxPresent = replicas.size == 1 && OUTPUTS.size > 0 && OUTPUTS(0).propositionBytes == selfScript

  val nftHolders = OUTPUTS.filter({ (b: Box) => b.tokens.exists({ (t: (Coll[Byte], Long)) => t._1 == selfId }) })
  val nftWellPlaced = nftHolders.size == 1 && nftHolders(0).tokens.size > 0 && nftHolders(0).tokens(0) == (selfId, 1L) && nftHolders(0).tokens.filter({ (t: (Coll[Byte], Long)) => t._1 == selfId }).size == 1
  val nftInReplica = isReplicationBoxPresent && nftWellPlaced && nftHolders(0).propositionBytes == selfScript
  val nftRetired = !isReplicationBoxPresent && nftWellPlaced && nftHolders(0).propositionBytes == terminalScript

  val isERGBase = baseTokenId.size == 0
  val temporaryFundingTokenAmountOnContract = {
    val pft = SELF.tokens.filter({ (t: (Coll[Byte], Long)) => t._1 == pftTokenId })
    if (pft.size > 0) pft(0)._2 else 0L
  }

  def getBaseTokenAmount(box: Box): Long = {
    if (isERGBase) box.value
    else {
      val bt = box.tokens.filter({ (t: (Coll[Byte], Long)) => t._1 == baseTokenId })
      if (bt.size > 0) bt(0)._2 else 0L
    }
  }

  val isSelfReplication = isReplicationBoxPresent && {
    val out = OUTPUTS(0)
    val r6 = out.R6[Coll[Long]].get
    val noAddsOtherTokens = if (isERGBase) {
      out.tokens.size >= 2 && out.tokens.size <= 3 && (out.tokens.size == 2 || out.tokens(2)._1 == pftTokenId)
    } else {
      out.tokens.size >= 2 && out.tokens.size <= 4 && out.tokens.forall({ (t: (Coll[Byte], Long)) =>
        t._1 == selfId || t._1 == selfAPTId || t._1 == pftTokenId || t._1 == baseTokenId
      })
    }
    out.tokens.size >= 2 &&
    out.tokens(0) == (selfId, 1L) &&
    out.tokens(1)._1 == selfAPTId &&
    out.tokens(1)._2 >= 1L &&
    r6.size == 3 &&
    out.R4[(Boolean, Long)].get == selfBlockLimit &&
    out.R5[Long].get == selfMinimumTokensSold &&
    out.R7[Long].get == selfExchangeRate &&
    out.R8[Coll[Coll[Byte]]].get == selfConstants &&
    out.R9[Coll[Byte]].get == selfProjectMetadata &&
    out.propositionBytes == selfScript &&
    noAddsOtherTokens
  }

  val APTokenRemainsConstant = isReplicationBoxPresent && OUTPUTS(0).tokens.size >= 2 && OUTPUTS(0).tokens(1)._1 == selfAPTId && OUTPUTS(0).tokens(1)._2 == selfAPT
  val ProofFundingTokenRemainsConstant = isReplicationBoxPresent && {
    val outPft = OUTPUTS(0).tokens.filter({ (t: (Coll[Byte], Long)) => t._1 == pftTokenId })
    if (temporaryFundingTokenAmountOnContract == 0L) outPft.size == 0
    else outPft.size == 1 && outPft(0)._2 == temporaryFundingTokenAmountOnContract
  }
  val SoldCounterRemainsConstant = isReplicationBoxPresent && OUTPUTS(0).R6[Coll[Long]].get(0) == selfSoldCounter
  val RefundCounterRemainsConstant = isReplicationBoxPresent && OUTPUTS(0).R6[Coll[Long]].get(1) == selfRefundCounter
  val AuxiliarExchangeCounterRemainsConstant = isReplicationBoxPresent && OUTPUTS(0).R6[Coll[Long]].get(2) == selfAuxiliarExchangeCounter
  val ergProtectedOnReplica = !isReplicationBoxPresent || (OUTPUTS(0).value >= selfValue)
    val mantainValue = isReplicationBoxPresent && ergProtectedOnReplica && (if (isERGBase) OUTPUTS(0).value >= selfValue else getBaseTokenAmount(OUTPUTS(0)) == getBaseTokenAmount(SELF))
    val ownerAuthentication: SigmaProp = sigmaProp(INPUTS.exists({ (b: Box) => b.propositionBytes == ownerErgotree })) || (if (ownerErgotree.size >= 3) { if (ownerErgotree.slice(0, 3) == fromBase16("0008cd")) proveDlog(decodePoint(ownerErgotree.slice(3, ownerErgotree.size))) else sigmaProp(false) } else sigmaProp(false))
  val deltaPFTokenAdded = {
    val outPft = OUTPUTS(0).tokens.filter({ (t: (Coll[Byte], Long)) => t._1 == pftTokenId })
    val outPftAmt = if (outPft.size > 0) outPft(0)._2 else 0L
    outPftAmt - temporaryFundingTokenAmountOnContract
  }
  val minimumReached = (selfSoldCounter - selfRefundCounter) >= selfMinimumTokensSold

  val isBuyTokens: SigmaProp = sigmaProp(isSelfReplication && ProofFundingTokenRemainsConstant && RefundCounterRemainsConstant && AuxiliarExchangeCounterRemainsConstant && ergProtectedOnReplica && {
    val out = OUTPUTS(0)
    val deltaAPT = selfAPT - out.tokens(1)._2
    val expectedBase = deltaAPT * selfExchangeRate
    val baseAdded = getBaseTokenAmount(out) - getBaseTokenAmount(SELF)
    val soldInc = out.R6[Coll[Long]].get(0) - selfSoldCounter
    deltaAPT > 0L && baseAdded == expectedBase && soldInc == deltaAPT
  })

  val isRefundTokens: SigmaProp = sigmaProp(!minimumReached && ((selfBlockLimit._1 && HEIGHT > selfBlockLimit._2) || (!selfBlockLimit._1 && CONTEXT.preHeader.timestamp > selfBlockLimit._2)) && isSelfReplication && ProofFundingTokenRemainsConstant && SoldCounterRemainsConstant && AuxiliarExchangeCounterRemainsConstant && (if (isERGBase) true else ergProtectedOnReplica) && {
    val out = OUTPUTS(0)
    val deltaAPT = out.tokens(1)._2 - selfAPT
    val expectedBase = deltaAPT * selfExchangeRate
    val baseSubtracted = getBaseTokenAmount(SELF) - getBaseTokenAmount(out)
    val refundInc = out.R6[Coll[Long]].get(1) - selfRefundCounter
    deltaAPT > 0L && baseSubtracted == expectedBase && refundInc == deltaAPT
  })

  val endOrReplicate = if (isReplicationBoxPresent) {
    isSelfReplication && APTokenRemainsConstant && ProofFundingTokenRemainsConstant && SoldCounterRemainsConstant && RefundCounterRemainsConstant && AuxiliarExchangeCounterRemainsConstant && (if (isERGBase) true else ergProtectedOnReplica) && (if (isERGBase) OUTPUTS(0).value >= 1000000L else true)
  } else {
    nftRetired
  }

  val isWithdrawFunds: SigmaProp = ownerAuthentication && sigmaProp(minimumReached && endOrReplicate && {
    val extractedBaseAmount = if (isReplicationBoxPresent) getBaseTokenAmount(SELF) - getBaseTokenAmount(OUTPUTS(0)) else getBaseTokenAmount(SELF)
    val devFeeAmount = if (devFee > 0) (extractedBaseAmount.toBigInt * devFee + 99) / 100 else 0.toBigInt
    val projectAmount = extractedBaseAmount.toBigInt - devFeeAmount
    val ownerOutputs = OUTPUTS.filter({ (b: Box) => b.propositionBytes == ownerErgotree && getBaseTokenAmount(b).toBigInt >= projectAmount })
    val devFeeOutputs = OUTPUTS.filter({ (b: Box) => blake2b256(b.propositionBytes) == devFeeContractBytesHash && getBaseTokenAmount(b).toBigInt >= devFeeAmount })
    extractedBaseAmount > 0L && projectAmount > 0 && ownerOutputs.size >= 1 && (if (devFee > 0) devFeeOutputs.size >= 1 && ownerOutputs(0).id != devFeeOutputs(0).id else true)
  })

  val isWithdrawUnsoldTokens : SigmaProp= ownerAuthentication && sigmaProp(isSelfReplication && APTokenRemainsConstant && SoldCounterRemainsConstant && RefundCounterRemainsConstant && AuxiliarExchangeCounterRemainsConstant && mantainValue && {
    deltaPFTokenAdded < 0L && (-deltaPFTokenAdded) <= temporaryFundingTokenAmountOnContract
  })

  val isAddTokens: SigmaProp = ownerAuthentication && sigmaProp(isSelfReplication && ProofFundingTokenRemainsConstant && SoldCounterRemainsConstant && RefundCounterRemainsConstant && AuxiliarExchangeCounterRemainsConstant && mantainValue && {
    OUTPUTS(0).tokens(1)._2 > selfAPT
  })

  val isExchangeFundingTokens: SigmaProp = sigmaProp(isSelfReplication && SoldCounterRemainsConstant && RefundCounterRemainsConstant && mantainValue && minimumReached && {
    val out = OUTPUTS(0)
    val deltaTFT = out.tokens(1)._2 - selfAPT
    val deltaTFT = out.tokens(1)._2 - selfAPT
  })

  sigmaProp(noExtraReplicas && (nftInReplica || nftRetired)) && (
    isBuyTokens || isRefundTokens || isWithdrawFunds || isWithdrawUnsoldTokens || isAddTokens || isExchangeFundingTokens
  )
}
