// Shared fixture: the exact park_a ACTIVE_OBJECTS payload Havana sends
// (subj=32 content, after the 2-byte subject header and before the chr(1)
// terminator) plus the exported v31 Lingo that parses it. Used by both the
// tree-walker test (park-vl64) and the VM equivalence test (vm.test.ts).
export const PARK_PAYLOAD =
  'SGSBMRDPBPA0.0\u0002I2\u0002Mqueue_tile2\u0002JMPGRAH0.0\u0002I2\u0002Mqueue_tile2\u0002SAMPFSAJ0.0\u0002I2\u0002Mqueue_tile2\u0002QBMRFSAPA0.0\u0002I2\u0002Mqueue_tile2\u0002SFMSERBJ0.0\u0002I2\u0002Mqueue_tile2\u0002SCMRFPBPA0.0\u0002I2\u0002Mqueue_tile2\u0002REMPGQBH0.0\u0002I2\u0002Mqueue_tile2\u0002PGMPFRBH0.0\u0002I2\u0002Mqueue_tile2\u0002PCMPEPBH0.0\u0002I2\u0002Mqueue_tile2\u0002QGMRFRBJ0.0\u0002I2\u0002Mqueue_tile2\u0002QDMRDQBPA0.0\u0002I2\u0002Mqueue_tile2\u0002RFMRERBJ0.0\u0002I2\u0002Mqueue_tile2\u0002PFMSDRBJ0.0\u0002I2\u0002Mqueue_tile2\u0002PDMPGPBH0.0\u0002I2\u0002Mqueue_tile2\u0002RGMSFRBJ0.0\u0002I2\u0002Mqueue_tile2\u0002RAMRESAPA0.0\u0002I2\u0002Mqueue_tile2\u0002RBMPGSAH0.0\u0002I2\u0002Mqueue_tile2\u0002SDMREQBPA0.0\u0002I2\u0002Mqueue_tile2\u0002QEMRFQBPA0.0\u0002I2\u0002Mqueue_tile2\u0002RCMPFPBH0.0\u0002I2\u0002Mqueue_tile2\u0002KMRDSAPA0.0\u0002I2\u0002Mqueue_tile2\u0002PAMPESAJ0.0\u0002I2\u0002Mqueue_tile2\u0002PBMQFSAJ0.0\u0002I2\u0002Mqueue_tile2\u0002IMPGQAH0.0\u0002I2\u0002Mqueue_tile2\u0002SEMRDRBJ0.0\u0002I2\u0002Mqueue_tile2\u0002QCMREPBPA0.0\u0002I2\u0002Mqueue_tile2\u0002SGMPGRBH0.0\u0002I2\u0002Mqueue_tile2\u0002QAMQESAJ0.0\u0002I2\u0002Mqueue_tile2\u0002QFMPERBH0.0\u0002I2\u0002Mqueue_tile2\u0002RDMPEQBH0.0\u0002I2\u0002Mqueue_tile2\u0002PEMPFQBH0.0\u0002I2\u0002Mqueue_tile2\u0002';

// EXACT v31 Connection_Instance_Class GetIntFrom/GetStrFrom (exported Lingo,
// verbatim) + v31 Room_Handler_Class parseActiveObject/handle_activeobjects.
// The only deviation: the furnidata branch is stubbed so positive classIDs
// are visible (diagnostic), everything else is byte-for-byte the export.
export const PARK_LINGO = `
property pMsgStruct

on GetIntFrom me
  if the traceScript then
    return 0
  end if
  the traceScript = 0
  tByteStr = pMsgStruct.getaProp(#content)
  tByte = bitAnd(charToNum(char 1 of tByteStr), 63)
  tByCnt = bitOr(bitAnd(tByte, 56) / 8, 0)
  tNeg = bitAnd(tByte, 4)
  tInt = bitAnd(tByte, 3)
  if tByCnt > 1 then
    tPowTbl = [4, 256, 16384, 1048576, 67108864]
    repeat with i = 2 to tByCnt
      tByte = bitAnd(charToNum(char i of tByteStr), 63)
      tInt = bitOr(tByte * tPowTbl[i - 1], tInt)
    end repeat
  end if
  if tNeg then
    tInt = -tInt
  end if
  pMsgStruct.setaProp(#content, tByteStr.char[tByCnt + 1..length(tByteStr)])
  return tInt
end

on GetStrFrom me
  tArr = pMsgStruct.getaProp(#content)
  tLen = offset(numToChar(2), tArr)
  if tLen > 1 then
    tStr = char 1 to tLen - 1 of tArr
  else
    tStr = EMPTY
  end if
  pMsgStruct.setaProp(#content, char tLen + 1 to length(tArr) of tArr)
  return tStr
end

on parseActiveObject me, tConn
  if not tConn then
    return 0
  end if
  tObj = [:]
  tObj[#id] = string(tConn.GetIntFrom())
  tClassID = tConn.GetIntFrom()
  if tClassID > -1 then
    tObj[#class] = "furni_" & tClassID
    tObj[#colors] = "0"
    tObj[#dimensions] = [1, 1]
  end if
  tObj[#x] = tConn.GetIntFrom()
  tObj[#y] = tConn.GetIntFrom()
  tDirection = tConn.GetIntFrom() mod 8
  tObj[#direction] = [tDirection, tDirection, tDirection]
  tObj[#altitude] = getLocalFloat(tConn.GetStrFrom())
  tExtra = tConn.GetIntFrom()
  tStuffData = tConn.GetStrFrom()
  tExpireTime = tConn.GetIntFrom()
  if tExpireTime > -1 then
    tExpireTime = tExpireTime * 60 * 1000 + the milliSeconds
  end if
  tObj[#expire] = tExpireTime
  if tClassID < 0 then
    tObj[#class] = tConn.GetStrFrom()
    tObj[#colors] = "0"
    tObj[#dimensions] = [1, 1]
  end if
  return tObj
end

on handle_activeobjects me, tMsg
  tConn = tMsg.connection
  tList = []
  tCount = tConn.GetIntFrom()
  repeat with i = 1 to tCount
    tObj = me.parseActiveObject(tConn)
    if listp(tObj) then
      tList.add(tObj)
    end if
  end repeat
  return tList
end
`;