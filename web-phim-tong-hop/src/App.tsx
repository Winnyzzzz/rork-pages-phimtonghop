import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import PhimTongHop from "./pages/PhimTongHop";
import PhimDetail from "./pages/PhimDetail";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

/** Giữ đường dẫn cũ /phimtonghop/:slug chuyển tiếp sang /phim/:slug */
const LegacyDetailRedirect = () => {
  const { slug } = useParams();
  return <Navigate to={slug ? `/phim/${slug}` : "/"} replace />;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/" element={<PhimTongHop />} />
          <Route path="/phim/:slug" element={<PhimDetail />} />
          <Route path="/phimtonghop" element={<Navigate to="/" replace />} />
          <Route path="/phimtonghop/:slug" element={<LegacyDetailRedirect />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
