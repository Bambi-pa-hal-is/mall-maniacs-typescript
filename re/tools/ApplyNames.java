// Applies the Mall Maniacs function names from re/ANALYSIS.md to the open maniac.exe program.
// Run from Ghidra's Script Manager (add re/tools to the script directories).
// @category MallManiacs
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.SourceType;

public class ApplyNames extends GhidraScript {
  private static final String[][] NAMES = {
    {"004160a0", "WinMain"},
    {"004165f0", "CreateGameWindow"},
    {"00409d90", "AppInit"},
    {"00435890", "Dff_LoadFile"},
    {"00410350", "LoadMasterConfig"},
    {"00432ea0", "Gx_LoadDriver"},
    {"00433280", "Gx_UnloadDriver"},
    {"004332f0", "Gx_SetVideoMode"},
    {"0040a4d0", "Game_Init"},
    {"0040aa10", "Game_Exit"},
    {"004104b0", "LoadMallScene"},
    {"004108a0", "LoadLevelContent"},
    {"00432320", "Sen_Load"},
    {"004320f0", "Sen_FixupMesh"},
    {"00432260", "Sen_ResolveTextures"},
    {"00416060", "Tpg_LoadTexture"},
    {"00410e90", "LoadPlayerConfig"},
    {"00411550", "CreateObjects"},
    {"00411b70", "SetupCameraAndStarts"},
    {"0040ad80", "GameFrame"},
    {"0040b3d0", "GameTick"},
    {"0040cf40", "PhysicsTick"},
    {"0040dfe0", "Clock_GetMs"},
    {"00401160", "Ai_UpdateStateMachine"},
    {"00408b60", "Console_Exec"},
    {"004089e0", "Console_Dispatch"},
    {"00407e10", "NavBuoys_Load"},
    {"00406cb0", "EventObjects_Load"},
    {"0040ffa0", "Quiz_Load"},
    {"00412810", "Hud_Draw"},
    {"00419c20", "Menu_Init"},
    {"0041a8c0", "Menu_Frame"},
    {"0041a670", "Menu_Exit"},
    {"0040ae30", "Game_Render"},
    {"0042f1c0", "Spitfire_RenderView"},
    {"0042f8c0", "Spitfire_DrawObject"},
    {"0042e940", "Spitfire_DrawPrimGroup"},
    {"004300d0", "Mesh_GetVertexFrame"},
    {"0042f6e0", "Node_UpdateWorld"},
    {"0042f030", "Node_BuildLocalMatrix"},
    {"0042f7d0", "Mat3_Mul"},
    {"0042d030", "Angle16_Sin"},
    {"0042d050", "Angle16_Cos"},
    {"00433a50", "Anm_LoadFile"},
    {"00433a90", "Anm_Parse"},
  };

  @Override
  public void run() throws Exception {
    for (String[] e : NAMES) {
      Function f = getFunctionAt(toAddr(e[0]));
      if (f == null) { println("no function at " + e[0]); continue; }
      f.setName(e[1], SourceType.USER_DEFINED);
    }
    println("Applied " + NAMES.length + " names.");
  }
}
